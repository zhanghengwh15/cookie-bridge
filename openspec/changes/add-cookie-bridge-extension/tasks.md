# 实现任务

## 阶段 1：骨架

- [x] 创建 `cookie-bridge-ext/` 目录与子目录 `lib/`、`icons/`
- [x] 写 `manifest.json`：MV3, `<all_urls>`, 权限 `cookies/scripting/tabs/alarms/storage`
- [x] 准备 16/48/128 png 占位图标

## 阶段 2：配置层

- [x] `lib/config.js`：`getSites()` / `addSite(url)` / `removeSite(hostname)` / `setEnabled(hostname, bool)` / `onChanged(cb)`
- [x] addSite 校验 `new URL(url)`，去重 hostname
- [ ] 单元测试用控制台跑一遍：增删读取（需浏览器环境，联调时执行）

## 阶段 3：background.js

- [x] 启动时 `loadSites` → `registerContentScripts`
- [x] `chrome.storage.onChanged` 监听 → 重新注册
- [x] `lsCache: Map<string, Map<string,string>>`
- [x] `debounceTimers: Map<string, number>`
- [x] `syncDomain(hostname)`：debounce 200ms → 拉 cookie → 读 lsCache → POST
- [x] `pushToTauri(payload)` + badge 反馈
- [x] `cookies.onChanged` 后缀匹配 hostname 触发
- [x] `alarms.create('sync', { periodInMinutes: 5 })` + onAlarm 全量
- [x] `runtime.onStartup` / `onInstalled` 全量同步
- [x] `runtime.onMessage`：`syncNow` / `addSite` / `removeSite` / `lsUpdate` / `getStatus`
- [x] `lsUpdate` 处理：更新 lsCache → syncDomain
- [x] removeSite 时清理 lsCache + debounce timer

## 阶段 4：content.js + inject.js

- [x] `inject.js`：hook `Storage.prototype.setItem/removeItem/clear`，`window.postMessage` 出去
- [x] `content.js`：在 `document_start` 用 `registerContentScripts` 直接注册 MAIN world（Chrome 111+）
- [x] content.js 监听 `window.message` 过滤 `__cookieBridge` → sendMessage `lsUpdate`
- [x] content.js 监听 `window.storage`（其他 tab 改动） → sendMessage `lsUpdate`
- [x] content.js 页面 load 时读全量 ls 推一次
- [x] content.js `setInterval(60_000)` 兜底全量推

## 阶段 5：popup

- [x] `popup.html`：列表 + 输入框 + 同步按钮 + 日志区
- [x] `popup.js`：列表展示 hostname + enabled 开关 + 删除按钮 + 最近同步时间
- [x] 添加按钮 → sendMessage `addSite`
- [x] 删除按钮 → sendMessage `removeSite`
- [x] 立即同步 → sendMessage `syncNow`
- [x] 错误展示（非法 URL / 重复）

## 阶段 6：联调

- [ ] 装入 Chrome 开发者模式（需手动操作）
- [ ] 在 popup 里加 `https://dbs.poi-t.cn/`，确认 cookie 推到 Tauri
- [ ] 在该域名页面 console 跑 `localStorage.setItem('foo','bar')`，<1s 内 Tauri 收到 lsUpdate 推送
- [ ] 把该域名 tab 切到后台 60s+，确认兜底也推
- [ ] 删除域名后确认 cs 卸载、停止推送
- [ ] 关掉 Tauri，扩展 badge 显示 ERR

## 阶段 7：文档

- [x] 在 `cookie-bridge-ext/README.md` 写"加载方法 + 调试方法 + 常见坑"
