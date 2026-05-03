# 设计：Chrome 扩展 Cookie Bridge

## 1. 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                  目标网站页面 (任意 tab)                          │
│  ┌──────────────────────────────────────────────────────┐       │
│  │ inject.js (MAIN world, document_start)               │       │
│  │   hook: Storage.prototype.setItem/removeItem/clear   │       │
│  │   → window.postMessage({ __cookieBridge: ... })      │       │
│  └──────────────────────────┬───────────────────────────┘       │
│                             │                                    │
│  ┌──────────────────────────▼───────────────────────────┐       │
│  │ content.js (isolated world)                          │       │
│  │   ① 注入 inject.js                                   │       │
│  │   ② load 时读全量 ls 推 background                    │       │
│  │   ③ 监听 window 'message'（来自 inject）              │       │
│  │   ④ 监听 window 'storage'（其他 tab 改的）            │       │
│  │   ⑤ 60s 兜底轮询 ls 全量                              │       │
│  └──────────────────────────┬───────────────────────────┘       │
└─────────────────────────────┼────────────────────────────────────┘
                              │ chrome.runtime.sendMessage
                              ▼
        ┌────────────────────────────────────────────┐
        │ background.js (service worker)             │
        │                                            │
        │  状态：                                     │
        │   - lsCache: Map<hostname, Map<k, v>>      │
        │   - debounceTimers: Map<hostname, timerId> │
        │                                            │
        │  触发源 → syncDomain(hostname):            │
        │   ① cookies.onChanged                      │
        │   ② alarm 'sync' (5 分钟全量)              │
        │   ③ runtime.onMessage 'lsUpdate' from cs   │
        │   ④ runtime.onMessage 'syncNow' from popup │
        │   ⑤ onStartup / onInstalled                │
        │                                            │
        │  配置变化（storage.onChanged）：             │
        │   → 重新 registerContentScripts             │
        └─────────────────────┬──────────────────────┘
                              │ HTTP POST
                              ▼
                  Tauri 127.0.0.1:8765/push
```

## 2. 决策详解

### 2.1 host 权限：`<all_urls>`

**为什么：** 用户要求运行时增删域名。manifest 的 `host_permissions` 是静态的，要支持任意 URL，要么 `<all_urls>` 一次性宽授权，要么 `optional_host_permissions` 每次弹窗。

**选择 `<all_urls>` 的理由：** 内部工具，不上架商店；用户自己装自己用，无需逐个授权 UX。

**取舍：** 扩展理论上能读所有站点的 cookie。可接受。

### 2.2 配置持久化：`chrome.storage.local`

```ts
type SiteConfig = {
  url: string;        // 用户输入的 URL，如 "https://dbs.poi-t.cn/"
  hostname: string;   // 派生：new URL(url).hostname
  enabled: boolean;
  addedAt: number;
};

chrome.storage.local: { sites: SiteConfig[] }
```

**为什么不放 `config.js`：** 那是代码，需要改文件 + 重新加载扩展。

**为什么需要 `hostname` 派生字段：** `chrome.cookies.getAll({domain})` 需要 hostname 而不是 URL（这是原方案的一个 bug）；content script `matches` 也需要 hostname。

**配置变化的副作用：**
- `chrome.storage.onChanged` 监听
- 触发 `chrome.scripting.unregisterContentScripts` + `registerContentScripts`
- `chrome.cookies.getAll({domain})` 立刻同步一次新增域名

### 2.3 localStorage 双轨策略

用户要求："**不活跃 tab 也要拿到，活跃 tab 高度实时**"。

**轨 1：活跃 tab 实时（毫秒级）**

content script + MAIN world hook：
```js
// inject.js (注入到 MAIN world, runAt: document_start)
const _set = Storage.prototype.setItem;
Storage.prototype.setItem = function(k, v) {
  _set.call(this, k, v);
  window.postMessage({ __cookieBridge: true, op: 'set', k, v }, '*');
};
// removeItem / clear 同理
```

**为什么必须 MAIN world：** isolated world 改写的 `Storage.prototype` 不影响页面代码看到的版本，hook 不到。

**为什么必须 `document_start`：** 必须在页面 JS 之前完成 hook，否则页面已经持有原始引用就 hook 不到了。

**轨 2：不活跃 tab 兜底（60s + 5min）**

只要 tab **存在**（哪怕在后台），content script 就活着，定时器照跑。
- content script 自己每 60s 读全量 ls 推一次
- background 每 5min 触发 syncDomain 全量推

**边界情况：** 用户从未在浏览器开过这个域名 → 读不到 ls。这是 Chrome 沙箱硬限制。但场景上无影响：用户必须先登录才有 cookie，登录的瞬间 tab 就存在了。

### 2.4 lsCache 在 background 内存

```ts
// background.js
const lsCache = new Map<string, Map<string, string>>();
// hostname → (key → value)
```

**为什么不持久化到 chrome.storage：**
- 数据真正的持久化在 Tauri 的 SQLite 里
- background 缓存只是为了"cookie 变化时能拿到当前 ls 一起推"
- SW 重启丢失没关系：alarm 5min 内会触发一次全量；content script 也会推

**为什么需要它：**
- cookies.onChanged 触发的 syncDomain 不应该再去找 tab 读 ls，那样有"没活跃 tab 就读不到"的退化
- 直接从 lsCache 读，没缓存就推个 `local_storage: null`，等下一次 content script 推上来

### 2.5 syncDomain 与 debounce

```ts
function syncDomain(hostname: string) {
  // 200ms 内同 hostname 的多次调用合并成一次
  clearTimeout(debounceTimers.get(hostname));
  const t = setTimeout(async () => {
    debounceTimers.delete(hostname);
    const cookies = await chrome.cookies.getAll({ domain: hostname });
    const ls = lsCache.get(hostname) ?? null;
    await pushToTauri({ domain: hostname, cookies: shape(cookies), local_storage: ls && Object.fromEntries(ls), ts: Date.now() });
  }, 200);
  debounceTimers.set(hostname, t);
}
```

**为什么 200ms：** 登录瞬间 cookies.onChanged 经常连发 5~10 次，200ms 足够合并；用户感知不到延迟。

### 2.6 popup → background 单向消息

popup 不直接读 cookie / 不直接 fetch。所有"动作"都是：
```js
chrome.runtime.sendMessage({ type: 'syncNow', hostname?: string })
chrome.runtime.sendMessage({ type: 'addSite', url: '...' })
chrome.runtime.sendMessage({ type: 'removeSite', hostname: '...' })
chrome.runtime.sendMessage({ type: 'getStatus' })  // 用于 UI 刷新
```

**为什么：** 消除原方案 popup.js / background.js 的逻辑重复；后续改协议只动一处。

### 2.7 content script 动态注册

要求 Chrome 111+。直接利用 `registerContentScripts` 的 `world: 'MAIN'`，免去运行时手动注入。

```js
// background 启动 / 配置变化 时
await chrome.scripting.unregisterContentScripts().catch(()=>{});
await chrome.scripting.registerContentScripts([
  {
    id: 'cs-main',
    matches: sites.map(s => `*://${s.hostname}/*`),
    js: ['inject.js'],
    runAt: 'document_start',
    world: 'MAIN',
    allFrames: false,
  },
  {
    id: 'cs-iso',
    matches: sites.map(s => `*://${s.hostname}/*`),
    js: ['content.js'],
    runAt: 'document_start',
    world: 'ISOLATED',
    allFrames: false,
  },
]);
```

inject.js 与 content.js 都在 `document_start` 注入；inject.js 在页面 JS 之前完成 hook，hook 触发时 `window.postMessage` 给同 tab 的 content.js（isolated world），content.js 再 `chrome.runtime.sendMessage` 给 background。

### 2.8 cookies.onChanged 父域匹配

cookie 的 `domain` 字段可能带前导点（`.poi-t.cn`）或精确（`dbs.poi-t.cn`）。配置里存的是精确 hostname。匹配规则：

```js
const cookieDomain = cookie.domain.replace(/^\./, '');
const matched = sites.filter(s =>
  s.hostname === cookieDomain || s.hostname.endsWith('.' + cookieDomain)
);
```

父域 cookie 变化（如 SSO `.poi-t.cn`）会同时触发多个子域 hostname 的 syncDomain。每个 syncDomain 各自全量推，存在网络冗余但 Tauri 端 UPSERT 合并，数据正确。可接受。

### 2.9 lsCache 与 clear 语义

```ts
// inject.js → content.js → background 的消息形态
type LsMessage =
  | { type: 'lsUpdate', op: 'set',    hostname: string, k: string, v: string }
  | { type: 'lsUpdate', op: 'remove', hostname: string, k: string }
  | { type: 'lsUpdate', op: 'clear',  hostname: string }
  | { type: 'lsUpdate', op: 'full',   hostname: string, all: Record<string,string> };  // load 时全量 / 60s 兜底
```

background 处理：
- `set` → `lsCache.get(host).set(k, v)`，没有 entry 时新建空 Map
- `remove` → `lsCache.get(host)?.delete(k)`
- `clear` → `lsCache.set(host, new Map())`（保留 entry 但内容为空，下次 syncDomain 推 `{}`）
- `full` → `lsCache.set(host, new Map(Object.entries(all)))`

### 2.10 ls 全量推，不做 key 过滤

实现简单，对你的 Go 端最友好（可枚举搜 token）。如果未来某站 ls 体积过大再加过滤。

### 2.11 popup UI 形态

```
┌─ Cookie Bridge ────────────────┐
│ Tauri: ✓ 在线 (8765)            │
│                                │
│ [https://___________] [+ 添加]  │
│                                │
│ ┌────────────────────────────┐ │
│ │ [✓] dbs.poi-t.cn        🗑 │ │
│ │     最近同步 12 秒前         │ │
│ │ [✓] release-platform...  🗑│ │
│ │     最近同步 4 分钟前        │ │
│ │ [ ] data-center-cloud... 🗑│ │
│ │     已禁用                   │ │
│ └────────────────────────────┘ │
│                                │
│ [    立即同步全部    ]          │
│                                │
│ ┌─ 日志 ─────────────────────┐ │
│ │ 14:22:11 [OK] dbs.poi-t.cn │ │
│ └────────────────────────────┘ │
└────────────────────────────────┘
```

- **enabled 开关**：每个 site 一个 checkbox。禁用 → 不参与 alarm/onChanged 触发，content script 也不注册到该域名。
- **Tauri 状态指示**：popup 打开时 `fetch /health` 一次，2s 超时；显示在线/离线。
- **日志区**：popup 自身存最近 50 条（chrome.storage.session 或内存数组），打开时从 background `getStatus` 拉取最近一批同步事件。

## 3. 模块划分

```
cookie-bridge-ext/
├── manifest.json          # MV3, <all_urls>
├── background.js          # SW 入口
├── content.js             # 注入到目标域名
├── inject.js              # MAIN world hook
├── popup.html
├── popup.js               # UI: 列表 + 增删 + 同步
├── lib/
│   ├── config.js          # storage.local CRUD + onChanged
│   └── sync.js            # syncDomain + pushToTauri + lsCache
└── icons/
```

## 4. 已知约束 / 不处理

- **HttpOnly cookie**：`chrome.cookies` API 能读到。
- **跨域 iframe 的 ls**：暂不处理（`allFrames: false`）。
- **隐身模式 tab**：默认扩展不在隐身模式运行，不处理。
- **service worker 被回收**：`chrome.alarms` 能唤醒它；lsCache 重建路径已说明。
- **Tauri 离线**：fetch 失败 → badge ERR + console error，不重试不排队（用户会注意到）。

## 5. 风险

| 风险 | 缓解 |
|---|---|
| MAIN world hook 在某些 SPA 框架下被覆盖 | 兜底有 60s 轮询 + 5min alarm |
| `<all_urls>` 让用户 Chrome 提示"读取所有网站数据" | 文档里说明，内部工具可接受 |
| 用户输入非法 URL | popup 用 `new URL()` 验证，失败提示 |
| 同一 hostname 多次添加 | addSite 时按 hostname 去重 |
