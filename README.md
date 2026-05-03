# Cookie Bridge Chrome 扩展

把已登录站点的 cookie / localStorage 同步给本地 Tauri 程序。

## 加载方法

1. 打开 Chrome，地址栏输入 `chrome://extensions/`
2. 右上角打开**开发者模式**
3. 点**加载已解压的扩展程序**
4. 选择本目录 `cookie-bridge-ext/`
5. 复制扩展 ID（后续需要时可用）

## 使用方法

1. 确保 Tauri 程序已启动（监听 `127.0.0.1:8765`）
2. 点击扩展图标打开 popup
3. 在输入框填入目标 URL（如 `https://dbs.poi-t.cn/`），点"+ 添加"
4. 在目标网站完成登录
5. cookie 会自动同步，localStorage 在页面活跃时实时同步，不活跃 tab 每 60 秒兜底一次
6. 点击"立即同步全部"可手动触发

## 调试方法

### 查看 service worker console

扩展卡片上点**检查视图：Service Worker**，弹出 DevTools 看 console。

### 查看 popup console

在 popup 上右键 → **检查**，弹出 DevTools。

### 查看 content script console

在目标网站页面按 F12，DevTools 的 Console 面板左上角下拉选择 `Cookie Bridge`（isolated world）或 `<top>`（MAIN world，inject.js 的 log 在这里）。

## 常见坑

- **CORS 错误**：manifest 已包含 `<all_urls>` 和 `http://127.0.0.1/*`，一般不会有问题。如果还有，检查 Tauri 的 CORS 配置。
- **localStorage 读不到**：必须有该域名的 tab 存在（哪怕在后台）。content script 只在页面加载后注入。
- **service worker 被休眠**：MV3 的 SW 会被回收。`chrome.alarms` 即使 SW 休眠也能唤醒，所以定时同步是可靠的。
- **badge 显示 ERR**：Tauri 没启动或端口被占。启动 Tauri 或检查端口。
- **Chrome 版本要求**：需要 Chrome 111+（支持 `registerContentScripts` 的 `world: 'MAIN'`）。
