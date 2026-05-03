# 新增能力：Chrome 扩展 Cookie Bridge

## 背景

`cookie-bridge-技术方案.md` 第 1 节描述了一个 Chrome MV3 扩展，作用是把已登录站点的 cookie / localStorage 推送到本地 Tauri 程序（HTTP `127.0.0.1:8765/push`），最终落到 SQLite 共享给 Go 业务程序使用。

原始方案存在以下需要决策的开放点，本提案将其固化：

- 目标域名是写死在 `config.js` 还是运行时可改？
- localStorage 同步如何兼顾"不活跃 tab 也能拿到"和"实时性"？
- popup 与 background 是否要避免逻辑重复？
- 一些隐性 bug：cookie 域名匹配错误、cookie.onChanged 抖动等。

## 目标

实现一个 Chrome MV3 扩展，能够：

1. 让用户在 popup 内**运行时增删**目标 URL，配置持久化在 `chrome.storage.local`
2. 自动同步目标域名的 cookie 到本地 Tauri HTTP 端点
3. 自动同步目标域名的 localStorage，**不活跃 tab 通过定时兜底拿到，活跃 tab 实时反馈**
4. 提供 popup 手动触发同步与状态反馈

## 非目标

- 多账号支持（暂不需要）
- 配置 JSON 导入/导出（popup 手动管理足够）
- 上架 Chrome Web Store（内部工具）
- 修改 Tauri 端 / Go 端代码（本提案只覆盖扩展）

## 关键决策（跟用户确认过）

| 决策 | 选择 | 理由 |
|---|---|---|
| host 权限 | `<all_urls>` | 简化运行时增删域名，无需逐个授权 |
| 配置存储 | `chrome.storage.local` | 跨 SW 重启持久化，支持 onChanged |
| 配置 UI | popup 手动增删，无导入导出 | 内部工具，需求简单 |
| ls 双轨策略 | content script + MAIN world hook（活跃 tab 实时）+ 60s 兜底轮询（保活 tab）+ alarm 全量（5 分钟） | 兼顾实时性与覆盖率 |
| ls 缓存位置 | background 内存 `Map<hostname, Map<key,value>>` | SW 重启会丢，由 alarm + content script 重建 |
| /push 协议 | 不动，继续按域名全量推 | 不影响 Tauri 端 |
| popup 与 background | popup 只发消息，background 唯一执行者 | 消除逻辑重复 |
| cookie.onChanged | 200ms debounce 按 hostname 合并 | 抑制登录瞬间的抖动 |
| alarm 兜底周期 | 5 分钟 | 保留方案原值 |

## 影响范围

- **新增能力**：`browser-cookie-sync`
- **修改文件**：仅新增 `cookie-bridge-ext/` 目录
- **不影响**：Tauri、Go、SQLite schema、HTTP 协议
