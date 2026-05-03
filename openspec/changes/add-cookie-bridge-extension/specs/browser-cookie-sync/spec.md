# Capability: browser-cookie-sync

## 范围

定义 Chrome 扩展把目标站点的 cookie 与 localStorage 同步到本地 Tauri HTTP 端点的行为契约。

## 配置

### 站点配置项

```ts
interface SiteConfig {
  url: string;        // 用户输入的完整 URL
  hostname: string;   // 派生：new URL(url).hostname，用于 cookie 与 cs 注册
  enabled: boolean;
  addedAt: number;    // unix ms
}
```

### 持久化

- 存储位置：`chrome.storage.local`，键名 `sites`
- 类型：`SiteConfig[]`
- 初始值：`[]`

### CRUD 行为

**addSite(url):**
- `new URL(url)` 必须不抛错，否则拒绝
- 若 `hostname` 已存在，拒绝（去重）
- 写入 storage 后自动触发：
  - 重新 `registerContentScripts`
  - 立即对该 hostname 执行一次 syncDomain

**removeSite(hostname):**
- 从 sites 移除
- 写入 storage 后自动触发：
  - 重新 `registerContentScripts`
  - 清理 lsCache 对应条目
  - 清理该 hostname 的 debounce timer

**listSites():** 返回当前配置数组。

## 同步触发源

`syncDomain(hostname)` 必须由以下事件之一触发：

| 触发源 | 时机 |
|---|---|
| `runtime.onStartup` / `onInstalled` | 浏览器启动 / 扩展装载后对所有 enabled site 触发一次 |
| `alarms.onAlarm name='sync'` | 每 5 分钟对所有 enabled site 触发 |
| `cookies.onChanged` | cookie 变化且其 domain 后缀匹配某个 site.hostname 时 |
| `runtime.onMessage type='syncNow'` | popup 手动触发 |
| `runtime.onMessage type='lsUpdate'` | content script 推送 ls 后，更新 lsCache 后触发 |

## syncDomain 行为

1. **debounce：** 同一 hostname 的多次调用，200ms 内合并为一次
2. **拉 cookies：** `chrome.cookies.getAll({ domain: hostname })`
3. **取 ls：** 从 background 内存 `lsCache.get(hostname)` 取，可能为 null
4. **POST：** 发送到 `http://127.0.0.1:8765/push`，payload 形态见下
5. **结果反馈：** 成功设置 badge `OK` 绿色 5 秒，失败 `ERR` 红色 5 秒

## /push payload 格式

继承原方案，**不修改**：

```json
{
  "domain": "<hostname>",
  "cookies": [
    {
      "domain": "...",
      "name": "...",
      "value": "...",
      "path": "/",
      "expires": 0,
      "secure": 0,
      "http_only": 0,
      "same_site": "unspecified"
    }
  ],
  "local_storage": { "k": "v" } | null,
  "ts": 1700000000000
}
```

`expires` 为 0 表示会话 cookie。`secure` / `http_only` 为 0/1。

## localStorage 同步行为

### content script 注入

- 要求 Chrome 111+
- 用 `chrome.scripting.registerContentScripts` 同时注册两个脚本到所有 `enabled` site 的 `*://${hostname}/*`：
  - `inject.js` —— `world: 'MAIN'`, `runAt: 'document_start'`
  - `content.js` —— `world: 'ISOLATED'`, `runAt: 'document_start'`
- 配置变化时全部 unregister + register
- `enabled: false` 的 site 不进入 matches

### 实时性（活跃 tab）

content script 必须在 `document_start` 注入 inject.js 到 MAIN world，hook：
- `Storage.prototype.setItem`
- `Storage.prototype.removeItem`
- `Storage.prototype.clear`

任何一次 hook 触发 → content script 立即推 `lsUpdate` 消息给 background。

### 兜底（不活跃 tab）

content script 必须每 60 秒读一次全量 localStorage 推给 background。

### background lsCache

- 数据结构：`Map<hostname, Map<string, string>>`
- 内存存储，SW 重启会丢失
- 收到 `lsUpdate` 消息时按 op 类型更新：
  - `set { k, v }` → `lsCache.get(host).set(k, v)`（无 entry 则新建空 Map）
  - `remove { k }` → `lsCache.get(host)?.delete(k)`
  - `clear` → `lsCache.set(host, new Map())`（保留 entry，syncDomain 推 `{}`）
  - `full { all }` → 整体替换：`lsCache.set(host, new Map(Object.entries(all)))`
- 更新后触发 `syncDomain(hostname)`

### cookies.onChanged 父域匹配

cookie domain 与配置 hostname 匹配规则（cookie domain 先去前导点）：

```
cookieDomain === hostname            → 匹配
hostname.endsWith('.' + cookieDomain) → 匹配（父域 cookie）
否则                                  → 不匹配
```

一次父域 cookie 变化可能触发多个 hostname 的 syncDomain，各自独立全量推。允许网络冗余。

## popup UI 行为

- **Tauri 在线状态**：打开时 `fetch http://127.0.0.1:8765/health`，2s 超时，显示在线/离线
- **站点列表**：显示 hostname + enabled 复选框 + 删除按钮 + 最近同步时间
- **enabled 复选框**：勾选/取消勾选触发 `setEnabled`，会重新注册 content script
- **添加 URL** 输入框，回车或按钮触发 `addSite`
- **立即同步全部**：触发 `syncNow`（无 hostname 参数 = 同步所有 enabled site）
- **日志区**：从 background `getStatus` 拉最近 50 条同步事件，时间倒序
- 添加 URL 失败（非法 URL / 重复 hostname）时在输入框下方显示错误文案

## 错误处理

- POST /push 失败：badge ERR + console.error，**不重试**（下一次触发会自然重试）
- chrome.cookies.getAll 失败：跳过本次推送，console.warn
- content script 无法注入（如 chrome:// 页面）：忽略，不报错

## 不在范围

- 多账号 / 账号切换
- 配置 JSON 导入导出
- 隐身模式
- 跨域 iframe 的 ls 同步（`allFrames: false`）
- 修改 Tauri / SQLite / Go 端
