# Chrome Cookie 同步技术方案

> 通过 Chrome 扩展 + Tauri 桌面程序 + SQLite，让 Go 程序无需自行登录即可拿到浏览器中已登录的 cookie 与 localStorage。

---

## 0. 总体架构

### 0.1 数据流

```
┌───────────────────────┐
│   用户手动在 Chrome   │
│     登录目标站点      │
└──────────┬────────────┘
           │
           ▼
┌───────────────────────┐    HTTP POST     ┌─────────────────────┐
│   Chrome 扩展（MV3）  │ ───────────────▶ │   Tauri 桌面程序    │
│ chrome.cookies API    │  /push (JSON)    │  axum HTTP server   │
│ scripting.execute     │                  │  rusqlite 写入      │
└───────────────────────┘                  └──────────┬──────────┘
                                                      │ WAL 写
                                                      ▼
                                           ┌─────────────────────┐
                                           │   data.db (SQLite)  │
                                           │   data.db-wal       │
                                           │   data.db-shm       │
                                           └──────────┬──────────┘
                                                      │ 只读
                                                      ▼
                                           ┌─────────────────────┐
                                           │     Go 业务程序     │
                                           │ modernc.org/sqlite  │
                                           └─────────────────────┘
```

### 0.2 各组件职责

| 组件 | 语言 | 职责 |
|---|---|---|
| Chrome 扩展 | JavaScript (MV3) | 监听 cookie 变化、读取 localStorage、按域名打包推送 |
| Tauri 程序 | Rust | 启动本地 HTTP 接收端口；持久化到 SQLite；提供托盘 UI |
| 共享存储 | SQLite (WAL) | 唯一事实来源，所有进程读写它 |
| Go 程序 | Go | 只读 SQLite，按需获取 cookie 用于业务请求 |

### 0.3 关键设计决策

1. **SQLite 必须开 WAL 模式**：实现"Tauri 写时 Go 可读"，是双进程并发的命门。
2. **Go 端只读打开**：物理隔绝任何意外写入冲突。
3. **数据库路径双方约定一致**：放在标准的应用数据目录。
4. **扩展只在浏览器对应域名标签存活时同步 localStorage**：因为 chrome.cookies API 能拿 cookie，但 localStorage 必须在页面上下文里读。
5. **数据按 domain + path + name 唯一**：UPSERT 写入，避免重复行。

### 0.4 目录约定（Windows）

```
%LOCALAPPDATA%\CookieBridge\
    ├── data.db          ← SQLite 主文件（双方都访问这里）
    ├── data.db-wal      ← WAL 日志（自动生成）
    └── data.db-shm      ← 共享内存索引（自动生成）
```

macOS/Linux 路径：

- macOS: `~/Library/Application Support/CookieBridge/data.db`
- Linux: `~/.local/share/CookieBridge/data.db`

---

## 1. Chrome 扩展

### 1.1 项目结构

```
cookie-bridge-ext/
├── manifest.json
├── background.js
├── popup.html
├── popup.js
└── icons/
    ├── 16.png
    ├── 48.png
    └── 128.png
```

### 1.2 配置目标域名

后续所有需要同步的域名都在这里维护，扩展和 Tauri 都按这个列表工作。

**`config.js`**（被 background.js 引用）：

```js
// 你想同步 cookie 的域名列表，按需增删
export const TARGET_DOMAINS = [
  "https://dbs.poi-t.cn/",
  "http://release-platform.poi-t.cn",
  "http://data-center-cloud-test.poi-t.cn",
];

// Tauri 接收端口（与 Tauri 程序里写的保持一致）
export const TAURI_ENDPOINT = "http://127.0.0.1:8765/push";

// 同步间隔（分钟），最小 1
export const SYNC_INTERVAL_MIN = 5;
```

### 1.3 manifest.json

```json
{
  "manifest_version": 3,
  "name": "Cookie Bridge",
  "version": "1.0.0",
  "description": "把已登录站点的 cookie / localStorage 同步给本地 Tauri 程序",
  "permissions": [
    "cookies",
    "scripting",
    "tabs",
    "alarms",
    "storage"
  ],
  "host_permissions": [
    "https://*.your-domain.com/*",
    "http://127.0.0.1/*"
  ],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/16.png",
      "48": "icons/48.png",
      "128": "icons/128.png"
    }
  },
  "icons": {
    "16": "icons/16.png",
    "48": "icons/48.png",
    "128": "icons/128.png"
  }
}
```

> `host_permissions` 必须包含**目标站点**和 **127.0.0.1**，否则 fetch 会被 CORS 拦截。

### 1.4 background.js（核心同步逻辑）

```js
import { TARGET_DOMAINS, TAURI_ENDPOINT, SYNC_INTERVAL_MIN } from "./config.js";

// ========= 工具方法 =========

async function getCookiesForDomain(domain) {
  // chrome.cookies.getAll 的 domain 字段做后缀匹配
  const cookies = await chrome.cookies.getAll({ domain });
  return cookies.map(c => ({
    domain: c.domain,
    name: c.name,
    value: c.value,
    path: c.path || "/",
    expires: c.expirationDate ? Math.floor(c.expirationDate) : 0,
    secure: c.secure ? 1 : 0,
    http_only: c.httpOnly ? 1 : 0,
    same_site: c.sameSite || "unspecified",
  }));
}

async function getLocalStorageForDomain(domain) {
  // localStorage 必须在页面上下文里读，需要找一个该域名的活跃标签页
  const tabs = await chrome.tabs.query({ url: `*://*.${domain.replace(/^\./, "")}/*` });
  if (tabs.length === 0) return null;

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: () => {
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          out[k] = localStorage.getItem(k);
        }
        return out;
      },
    });
    return result;
  } catch (e) {
    console.warn("[CookieBridge] localStorage 读取失败", domain, e);
    return null;
  }
}

async function pushToTauri(payload) {
  try {
    const res = await fetch(TAURI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    console.log("[CookieBridge] 推送成功", payload.domain, json);
    setBadge("OK", "#16a34a");
  } catch (e) {
    console.error("[CookieBridge] 推送失败", e);
    setBadge("ERR", "#dc2626");
  }
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  // 5 秒后清除
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 5000);
}

// ========= 主同步函数 =========

async function syncAll() {
  for (const domain of TARGET_DOMAINS) {
    const cookies = await getCookiesForDomain(domain);
    const ls = await getLocalStorageForDomain(domain);
    if (cookies.length === 0 && !ls) continue;

    await pushToTauri({
      domain,
      cookies,
      local_storage: ls,
      ts: Date.now(),
    });
  }
}

// ========= 触发时机 =========

// 1. 启动时同步一次
chrome.runtime.onStartup.addListener(syncAll);
chrome.runtime.onInstalled.addListener(syncAll);

// 2. 定时同步
chrome.alarms.create("sync", { periodInMinutes: SYNC_INTERVAL_MIN });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === "sync") syncAll();
});

// 3. cookie 变化时实时同步对应域名
chrome.cookies.onChanged.addListener(async ({ cookie }) => {
  const matched = TARGET_DOMAINS.find(d =>
    cookie.domain.endsWith(d.replace(/^\./, ""))
  );
  if (!matched) return;

  const cookies = await getCookiesForDomain(matched);
  const ls = await getLocalStorageForDomain(matched);
  await pushToTauri({
    domain: matched,
    cookies,
    local_storage: ls,
    ts: Date.now(),
  });
});

// 4. 点击扩展图标手动触发（也走 popup，这里留作兜底）
chrome.action.onClicked.addListener(syncAll);
```

### 1.5 popup.html（手动触发与状态查看）

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font: 13px/1.5 system-ui; width: 240px; padding: 12px; }
    button { width: 100%; padding: 8px; margin-top: 8px; cursor: pointer; }
    #log { margin-top: 10px; max-height: 160px; overflow: auto;
           font: 11px ui-monospace, monospace; color: #555; }
    .ok { color: #16a34a; } .err { color: #dc2626; }
  </style>
</head>
<body>
  <div><strong>Cookie Bridge</strong></div>
  <button id="sync">立即同步</button>
  <div id="log"></div>
  <script src="popup.js" type="module"></script>
</body>
</html>
```

### 1.6 popup.js

```js
import { TARGET_DOMAINS, TAURI_ENDPOINT } from "./config.js";

const logEl = document.getElementById("log");
const append = (text, cls = "") => {
  const p = document.createElement("div");
  p.textContent = `${new Date().toLocaleTimeString()} ${text}`;
  p.className = cls;
  logEl.prepend(p);
};

document.getElementById("sync").addEventListener("click", async () => {
  for (const domain of TARGET_DOMAINS) {
    const cookies = await chrome.cookies.getAll({ domain });
    const tabs = await chrome.tabs.query({
      url: `*://*.${domain.replace(/^\./, "")}/*`,
    });
    let ls = null;
    if (tabs[0]) {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: () => ({ ...localStorage }),
      });
      ls = result;
    }
    try {
      const res = await fetch(TAURI_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain,
          cookies: cookies.map(c => ({
            domain: c.domain, name: c.name, value: c.value,
            path: c.path || "/",
            expires: c.expirationDate ? Math.floor(c.expirationDate) : 0,
            secure: c.secure ? 1 : 0,
            http_only: c.httpOnly ? 1 : 0,
            same_site: c.sameSite || "unspecified",
          })),
          local_storage: ls,
          ts: Date.now(),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      append(`[OK] ${domain} cookies=${cookies.length}`, "ok");
    } catch (e) {
      append(`[ERR] ${domain} ${e.message}`, "err");
    }
  }
});
```

### 1.7 加载与调试

1. 打开 `chrome://extensions/`，右上角打开**开发者模式**。
2. 点**加载已解压的扩展程序**，选 `cookie-bridge-ext` 目录。
3. 复制扩展 ID（后续需要时用）。
4. 调试 service worker：扩展卡片上点**检查视图：Service Worker**，弹出 DevTools 看 console。
5. 测试触发：先把 Tauri 跑起来，再点扩展图标 → "立即同步"，看 popup 日志和 service worker console。

### 1.8 常见坑

- **CORS 错误**：检查 `host_permissions` 是否包含 `http://127.0.0.1/*`。
- **localStorage 读不到**：必须有该域名的活跃 tab。可以扩展逻辑改为"自动新开隐藏 tab 读完关闭"，但成本较高，建议先简单点。
- **cookie 字段缺失**：HttpOnly cookie 需要 `cookies` 权限——已经在 manifest 里申请了，但确认浏览器没有拦截。
- **service worker 被休眠**：MV3 的 SW 会被回收。`chrome.alarms` 即使 SW 休眠也能唤醒，所以定时同步是可靠的。

---

## 2. Tauri 端（接收 + 落库）

### 2.1 项目初始化

```bash
# 需要先装好 Rust 和 Node.js
npm create tauri-app@latest cookie-bridge-app
# 选择: TypeScript / vanilla / npm（前端用什么不重要，主要写 Rust）
cd cookie-bridge-app
```

### 2.2 src-tauri/Cargo.toml

```toml
[package]
name = "cookie-bridge-app"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "1", features = [] }

[dependencies]
tauri = { version = "1", features = ["shell-open", "system-tray"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
axum = "0.7"
tower-http = { version = "0.5", features = ["cors"] }
rusqlite = { version = "0.31", features = ["bundled"] }
anyhow = "1"
dirs = "5"
chrono = "0.4"
tracing = "0.1"
tracing-subscriber = "0.3"

[features]
custom-protocol = ["tauri/custom-protocol"]
```

> `rusqlite` 的 `bundled` feature 会把 SQLite C 源码编译进来，避免运行时找不到 sqlite3.dll。

### 2.3 src-tauri/tauri.conf.json 关键片段

```json
{
  "build": { "distDir": "../dist", "devPath": "../dist" },
  "tauri": {
    "bundle": { "identifier": "com.you.cookiebridge" },
    "systemTray": {
      "iconPath": "icons/icon.png",
      "iconAsTemplate": true
    },
    "windows": [
      {
        "title": "Cookie Bridge",
        "width": 480,
        "height": 320,
        "visible": false
      }
    ]
  }
}
```

### 2.4 src-tauri/src/db.rs

```rust
use anyhow::Result;
use rusqlite::{params, Connection};
use std::path::PathBuf;

/// 返回数据库文件路径，并确保父目录存在
pub fn db_path() -> Result<PathBuf> {
    let base = dirs::data_local_dir()
        .ok_or_else(|| anyhow::anyhow!("找不到 LocalAppData"))?;
    let dir = base.join("CookieBridge");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("data.db"))
}

pub fn open() -> Result<Connection> {
    let conn = Connection::open(db_path()?)?;
    // 一次性把数据库设成 WAL 模式（写入数据库本身，全局生效）
    conn.execute_batch(
        "
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;
        PRAGMA busy_timeout=5000;
        ",
    )?;
    init_schema(&conn)?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS cookies (
            domain     TEXT NOT NULL,
            name       TEXT NOT NULL,
            value      TEXT NOT NULL,
            path       TEXT NOT NULL DEFAULT '/',
            expires    INTEGER NOT NULL DEFAULT 0,
            secure     INTEGER NOT NULL DEFAULT 0,
            http_only  INTEGER NOT NULL DEFAULT 0,
            same_site  TEXT,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (domain, path, name)
        );

        CREATE INDEX IF NOT EXISTS idx_cookies_domain ON cookies(domain);

        CREATE TABLE IF NOT EXISTS local_storage (
            domain     TEXT NOT NULL,
            key        TEXT NOT NULL,
            value      TEXT,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (domain, key)
        );

        CREATE TABLE IF NOT EXISTS sync_log (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            domain     TEXT NOT NULL,
            cookie_n   INTEGER NOT NULL,
            ls_n       INTEGER NOT NULL,
            ts         INTEGER NOT NULL
        );
        ",
    )?;
    Ok(())
}

#[derive(serde::Deserialize, Debug)]
pub struct CookieIn {
    pub domain: String,
    pub name: String,
    pub value: String,
    pub path: String,
    pub expires: i64,
    pub secure: i64,
    pub http_only: i64,
    pub same_site: Option<String>,
}

#[derive(serde::Deserialize, Debug)]
pub struct PushPayload {
    pub domain: String,
    pub cookies: Vec<CookieIn>,
    pub local_storage: Option<std::collections::HashMap<String, String>>,
    pub ts: i64,
}

pub fn save_payload(conn: &mut Connection, p: &PushPayload) -> Result<(usize, usize)> {
    let now = chrono::Utc::now().timestamp();
    let tx = conn.transaction()?;

    // 删除该 domain 下已经过期的 cookie（可选清理）
    tx.execute(
        "DELETE FROM cookies WHERE domain = ?1 AND expires != 0 AND expires < ?2",
        params![p.domain, now],
    )?;

    let mut cookie_n = 0;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO cookies(domain,name,value,path,expires,secure,http_only,same_site,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(domain,path,name) DO UPDATE SET
               value=excluded.value,
               expires=excluded.expires,
               secure=excluded.secure,
               http_only=excluded.http_only,
               same_site=excluded.same_site,
               updated_at=excluded.updated_at",
        )?;
        for c in &p.cookies {
            stmt.execute(params![
                c.domain, c.name, c.value, c.path,
                c.expires, c.secure, c.http_only,
                c.same_site, now,
            ])?;
            cookie_n += 1;
        }
    }

    let mut ls_n = 0;
    if let Some(ls) = &p.local_storage {
        let mut stmt = tx.prepare(
            "INSERT INTO local_storage(domain,key,value,updated_at)
             VALUES (?1,?2,?3,?4)
             ON CONFLICT(domain,key) DO UPDATE SET
               value=excluded.value,
               updated_at=excluded.updated_at",
        )?;
        for (k, v) in ls {
            stmt.execute(params![p.domain, k, v, now])?;
            ls_n += 1;
        }
    }

    tx.execute(
        "INSERT INTO sync_log(domain, cookie_n, ls_n, ts) VALUES (?1,?2,?3,?4)",
        params![p.domain, cookie_n as i64, ls_n as i64, now],
    )?;

    tx.commit()?;
    Ok((cookie_n, ls_n))
}
```

### 2.5 src-tauri/src/server.rs

```rust
use crate::db;
use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use rusqlite::Connection;
use serde_json::json;
use std::sync::{Arc, Mutex};
use tower_http::cors::{Any, CorsLayer};

type AppState = Arc<Mutex<Connection>>;

pub async fn run(port: u16) -> anyhow::Result<()> {
    let conn = db::open()?;
    let state: AppState = Arc::new(Mutex::new(conn));

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/push", post(push_handler))
        .route("/health", axum::routing::get(|| async { "ok" }))
        .layer(cors)
        .with_state(state);

    let addr = format!("127.0.0.1:{}", port).parse()?;
    tracing::info!("HTTP server listening on {}", addr);
    axum::Server::bind(&addr)
        .serve(app.into_make_service())
        .await?;
    Ok(())
}

async fn push_handler(
    State(state): State<AppState>,
    Json(payload): Json<db::PushPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let mut conn = state.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    match db::save_payload(&mut conn, &payload) {
        Ok((c, l)) => {
            tracing::info!("saved domain={} cookies={} ls={}", payload.domain, c, l);
            Ok(Json(json!({ "ok": true, "cookies": c, "local_storage": l })))
        }
        Err(e) => {
            tracing::error!("save failed: {:?}", e);
            Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
        }
    }
}
```

### 2.6 src-tauri/src/main.rs

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod server;

use tauri::{
    CustomMenuItem, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu,
    SystemTrayMenuItem,
};

const HTTP_PORT: u16 = 8765;

fn build_tray() -> SystemTray {
    let show = CustomMenuItem::new("show".to_string(), "打开窗口");
    let open_db = CustomMenuItem::new("open_db".to_string(), "打开数据目录");
    let quit = CustomMenuItem::new("quit".to_string(), "退出");
    let menu = SystemTrayMenu::new()
        .add_item(show)
        .add_item(open_db)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(quit);
    SystemTray::new().with_menu(menu)
}

fn main() {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    // 后台 tokio 任务跑 HTTP server
    tauri::async_runtime::spawn(async {
        if let Err(e) = server::run(HTTP_PORT).await {
            tracing::error!("server crashed: {:?}", e);
        }
    });

    tauri::Builder::default()
        .system_tray(build_tray())
        .on_system_tray_event(|app, event| {
            if let SystemTrayEvent::MenuItemClick { id, .. } = event {
                match id.as_str() {
                    "show" => {
                        if let Some(w) = app.get_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "open_db" => {
                        if let Ok(path) = db::db_path() {
                            if let Some(parent) = path.parent() {
                                let _ = open::that(parent);
                            }
                        }
                    }
                    "quit" => std::process::exit(0),
                    _ => {}
                }
            }
        })
        .on_window_event(|e| {
            // 关窗口时不退出，最小化到托盘
            if let tauri::WindowEvent::CloseRequested { api, .. } = e.event() {
                e.window().hide().unwrap();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![db_path_cmd])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn db_path_cmd() -> Result<String, String> {
    db::db_path()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}
```

> `open` crate 用于跨平台打开目录，需要在 `Cargo.toml` 加 `open = "5"`。如果不要这个功能，删掉 `open_db` 那段即可。

### 2.7 自启动（可选但推荐）

让 Tauri 开机自启，Go 程序就总是能拿到最新数据。

`Cargo.toml` 加：
```toml
tauri-plugin-autostart = { git = "https://github.com/tauri-apps/plugins-workspace", branch = "v1" }
```

`main.rs` 注册：
```rust
.plugin(tauri_plugin_autostart::init(
    tauri_plugin_autostart::MacosLauncher::LaunchAgent,
    Some(vec![]),
))
```

然后在前端调用 enable() 即可（或者用脚本提前注册到 Windows 启动项）。

### 2.8 编译与运行

```bash
cd cookie-bridge-app
npm install
npm run tauri dev          # 开发模式
npm run tauri build        # 打 release 包
```

打包产物（Windows）位于 `src-tauri/target/release/bundle/`。

### 2.9 验证

在 Tauri 跑起来后，单独测一下 HTTP 端：

```bash
curl http://127.0.0.1:8765/health
# 应输出: ok

curl -X POST http://127.0.0.1:8765/push \
  -H "Content-Type: application/json" \
  -d '{"domain":"test.com","cookies":[{"domain":"test.com","name":"sid","value":"abc","path":"/","expires":0,"secure":0,"http_only":0}],"local_storage":null,"ts":1700000000000}'
# 应输出: {"ok":true,"cookies":1,"local_storage":0}
```

然后用 SQLite 客户端打开 `%LOCALAPPDATA%\CookieBridge\data.db`，能看到一条 cookie 记录即成功。

---

## 3. Go 项目（读取端）

### 3.1 选库

使用 **`modernc.org/sqlite`**（纯 Go，免 cgo，跨平台编译省心）：

```bash
go get modernc.org/sqlite
```

> 如果性能确实是瓶颈再换 `github.com/mattn/go-sqlite3`，但读这点 cookie 数据完全用不上。

### 3.2 项目结构建议

```
your-go-project/
├── go.mod
├── main.go
└── internal/
    └── cookiebridge/
        ├── client.go      ← 封装好的读取 client
        └── client_test.go
```

### 3.3 internal/cookiebridge/client.go

```go
package cookiebridge

import (
	"database/sql"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// Client 用于从 Cookie Bridge 共享的 SQLite 库中读取 cookie / localStorage
type Client struct {
	db *sql.DB
}

// DefaultDBPath 返回与 Tauri 程序约定一致的数据库路径
func DefaultDBPath() (string, error) {
	var base string
	switch runtime.GOOS {
	case "windows":
		base = os.Getenv("LOCALAPPDATA")
		if base == "" {
			base = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
		}
	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, "Library", "Application Support")
	default: // linux
		base = os.Getenv("XDG_DATA_HOME")
		if base == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return "", err
			}
			base = filepath.Join(home, ".local", "share")
		}
	}
	return filepath.Join(base, "CookieBridge", "data.db"), nil
}

// New 打开共享数据库（只读模式）
func New(dbPath string) (*Client, error) {
	if _, err := os.Stat(dbPath); err != nil {
		return nil, fmt.Errorf("数据库不存在 %s，请先确认 Tauri 程序在运行: %w", dbPath, err)
	}
	dsn := fmt.Sprintf("file:%s?mode=ro&_pragma=busy_timeout(5000)", dbPath)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	if err := db.Ping(); err != nil {
		return nil, err
	}
	return &Client{db: db}, nil
}

func (c *Client) Close() error { return c.db.Close() }

// Cookie 表示一条 cookie
type Cookie struct {
	Domain   string
	Name     string
	Value    string
	Path     string
	Expires  int64 // unix 秒, 0 = 会话 cookie
	Secure   bool
	HttpOnly bool
	SameSite string
}

// GetCookies 按域名获取尚未过期的 cookie。
// 支持后缀匹配：传 "your-domain.com" 时会同时返回 "*.your-domain.com" 的 cookie。
func (c *Client) GetCookies(domain string) ([]Cookie, error) {
	now := time.Now().Unix()
	rows, err := c.db.Query(`
		SELECT domain, name, value, path, expires, secure, http_only, same_site
		FROM cookies
		WHERE (domain = ?1 OR domain = '.' || ?1 OR domain LIKE '%.' || ?1)
		  AND (expires = 0 OR expires > ?2)
	`, domain, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Cookie
	for rows.Next() {
		var ck Cookie
		var sec, ho int
		var ss sql.NullString
		if err := rows.Scan(&ck.Domain, &ck.Name, &ck.Value, &ck.Path,
			&ck.Expires, &sec, &ho, &ss); err != nil {
			return nil, err
		}
		ck.Secure = sec == 1
		ck.HttpOnly = ho == 1
		ck.SameSite = ss.String
		out = append(out, ck)
	}
	return out, rows.Err()
}

// CookieHeader 把 cookie 拼成 "k=v; k2=v2" 的 Cookie 请求头
func (c *Client) CookieHeader(domain string) (string, error) {
	cs, err := c.GetCookies(domain)
	if err != nil {
		return "", err
	}
	parts := make([]string, 0, len(cs))
	for _, ck := range cs {
		parts = append(parts, ck.Name+"="+ck.Value)
	}
	return strings.Join(parts, "; "), nil
}

// HTTPClient 返回一个带 cookie jar 的 *http.Client，用于直接发请求
func (c *Client) HTTPClient(domain string) (*http.Client, error) {
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, err
	}
	cs, err := c.GetCookies(domain)
	if err != nil {
		return nil, err
	}

	// 把 cookie 注入 jar，按 https://domain 注入即可
	rootURL := &url.URL{Scheme: "https", Host: strings.TrimPrefix(domain, ".")}
	httpCookies := make([]*http.Cookie, 0, len(cs))
	for _, ck := range cs {
		hc := &http.Cookie{
			Name:     ck.Name,
			Value:    ck.Value,
			Path:     ck.Path,
			Domain:   ck.Domain,
			Secure:   ck.Secure,
			HttpOnly: ck.HttpOnly,
		}
		if ck.Expires > 0 {
			hc.Expires = time.Unix(ck.Expires, 0)
		}
		httpCookies = append(httpCookies, hc)
	}
	jar.SetCookies(rootURL, httpCookies)

	return &http.Client{Jar: jar, Timeout: 30 * time.Second}, nil
}

// GetLocalStorage 获取该域名下的 localStorage 全部 KV
func (c *Client) GetLocalStorage(domain string) (map[string]string, error) {
	rows, err := c.db.Query(
		`SELECT key, value FROM local_storage WHERE domain = ?`, domain)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]string{}
	for rows.Next() {
		var k string
		var v sql.NullString
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v.String
	}
	return out, rows.Err()
}

// LastSync 返回该域名最近一次同步的时间。如果从未同步过，返回 zero time。
func (c *Client) LastSync(domain string) (time.Time, error) {
	var ts sql.NullInt64
	err := c.db.QueryRow(
		`SELECT MAX(ts) FROM sync_log WHERE domain = ?`, domain).Scan(&ts)
	if err != nil {
		return time.Time{}, err
	}
	if !ts.Valid {
		return time.Time{}, nil
	}
	return time.Unix(ts.Int64, 0), nil
}
```

### 3.4 main.go 使用示例

```go
package main

import (
	"fmt"
	"io"
	"log"

	"your-module/internal/cookiebridge"
)

func main() {
	dbPath, err := cookiebridge.DefaultDBPath()
	if err != nil {
		log.Fatal(err)
	}

	cli, err := cookiebridge.New(dbPath)
	if err != nil {
		log.Fatal(err)
	}
	defer cli.Close()

	// 检查最近一次同步时间
	last, _ := cli.LastSync("your-domain.com")
	fmt.Println("最后同步时间:", last)

	// 方式 1: 拿原始 cookie 列表
	cookies, err := cli.GetCookies("your-domain.com")
	if err != nil {
		log.Fatal(err)
	}
	for _, c := range cookies {
		fmt.Printf("  %s = %.20s...\n", c.Name, c.Value)
	}

	// 方式 2: 直接用预设好 cookie 的 http.Client
	httpCli, err := cli.HTTPClient("your-domain.com")
	if err != nil {
		log.Fatal(err)
	}
	resp, err := httpCli.Get("https://your-domain.com/api/me")
	if err != nil {
		log.Fatal(err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	fmt.Printf("API 返回 %d: %s\n", resp.StatusCode, body)

	// 方式 3: 获取 localStorage（如某些站点 token 存这里）
	ls, _ := cli.GetLocalStorage("your-domain.com")
	if token, ok := ls["access_token"]; ok {
		fmt.Println("access_token:", token)
	}
}
```

### 3.5 单元测试 client_test.go

```go
package cookiebridge

import (
	"os"
	"path/filepath"
	"testing"
)

func TestClientReadOnly(t *testing.T) {
	path, err := DefaultDBPath()
	if err != nil {
		t.Skip("无默认路径")
	}
	if _, err := os.Stat(path); err != nil {
		// 测试时如果没有 Tauri 跑过，使用一个临时空库
		tmp := filepath.Join(t.TempDir(), "test.db")
		if err := initEmptyDB(tmp); err != nil {
			t.Fatal(err)
		}
		path = tmp
	}

	cli, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	defer cli.Close()

	cs, err := cli.GetCookies("nonexistent.example")
	if err != nil {
		t.Fatal(err)
	}
	if cs != nil && len(cs) > 0 {
		t.Errorf("不应该有 cookie")
	}
}

func initEmptyDB(path string) error {
	// 用同样 schema 创建临时 db，仅供测试
	// 略：复制 Tauri 端的 CREATE TABLE
	return nil
}
```

### 3.6 编译

```bash
go build -o myapp ./...
# Windows 交叉编译
GOOS=windows GOARCH=amd64 go build -o myapp.exe ./...
```

`modernc.org/sqlite` 是纯 Go，不需要 cgo，交叉编译完全无障碍。

---

## 4. 上线运行 / 联调清单

### 4.1 启动顺序

1. **先启动 Tauri 程序**（开机自启会自动满足）
2. 浏览器装好扩展，打开目标站点完成登录
3. 等扩展自动同步（最多 5 分钟）或点扩展图标手动触发
4. 启动 Go 业务程序

### 4.2 验证链路

1. `curl http://127.0.0.1:8765/health` → 验证 Tauri 在线
2. 扩展 popup 点"立即同步" → 看日志显示 OK
3. 用 SQLite 客户端打开 `data.db`，执行 `SELECT COUNT(*) FROM cookies;` 应该 > 0
4. 跑 Go 程序，应该能拿到 cookie 并正常请求 API

### 4.3 故障排查

| 现象 | 原因 | 解决 |
|---|---|---|
| 扩展 console 报 CORS | manifest 缺 `127.0.0.1` host_permissions | 加上后重新加载扩展 |
| 扩展 fetch 报 ERR_CONNECTION_REFUSED | Tauri 没启动或端口被占 | 启动 Tauri / 改端口 |
| Go 报 `database is locked` | 没开 WAL 或未设 busy_timeout | 检查 Tauri 端 PRAGMA |
| Go 拿到的 cookie 是空 | 域名没匹配上（注意 `.domain` 前缀） | 用 `GetCookies` 自带的后缀匹配，或检查表里 domain 字段实际值 |
| API 返回 401 | cookie 过期，但 expires 字段没记录正确 | 让用户在浏览器里刷新页面重新登录，扩展会自动同步 |
| Tauri 关闭后 wal 文件还在 | 正常现象 | 退出前调用 `PRAGMA wal_checkpoint(TRUNCATE)`，或忽略 |

### 4.4 监控建议

- **Tauri 托盘菜单**显示"最近同步：xx 秒前"
- **扩展 badge** 用绿色 OK / 红色 ERR 实时反馈
- **Go 端**调用 `LastSync()` 检查数据新鲜度，太老就提示用户去浏览器刷新登录

### 4.5 安全注意

- HTTP 端口只绑定 `127.0.0.1`，外部网络无法访问
- 扩展 manifest 的 `host_permissions` 应当**精确到目标域名**，不要用 `*://*/*`
- 数据库文件含敏感 cookie，**Windows 下应保持在 LocalAppData**（用户私有），别放到共享路径
- Go 端只读模式打开能避免误改数据库

### 4.6 后续可扩展

- **多账号支持**：cookies 表加一列 `account_label`，扩展 popup 让用户选当前是哪个账号
- **历史快照**：保留 sync_log 即可回溯
- **加密**：用系统 keychain 存对称密钥，Tauri 加密入库、Go 端解密
- **Linux 支持**：Tauri 已经跨平台，Chrome 扩展也是；只需测试一下路径

---

## 附录 A：SQLite 表结构汇总

```sql
-- 主表：cookies
CREATE TABLE cookies (
    domain     TEXT NOT NULL,
    name       TEXT NOT NULL,
    value      TEXT NOT NULL,
    path       TEXT NOT NULL DEFAULT '/',
    expires    INTEGER NOT NULL DEFAULT 0,    -- unix 秒，0 表示会话 cookie
    secure     INTEGER NOT NULL DEFAULT 0,
    http_only  INTEGER NOT NULL DEFAULT 0,
    same_site  TEXT,                          -- 'no_restriction' | 'lax' | 'strict' | 'unspecified'
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (domain, path, name)
);
CREATE INDEX idx_cookies_domain ON cookies(domain);

-- localStorage
CREATE TABLE local_storage (
    domain     TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (domain, key)
);

-- 同步日志（用于查询最后同步时间）
CREATE TABLE sync_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    domain     TEXT NOT NULL,
    cookie_n   INTEGER NOT NULL,
    ls_n       INTEGER NOT NULL,
    ts         INTEGER NOT NULL
);
```

## 附录 B：HTTP 接口契约

### POST /push

请求体：
```json
{
  "domain": "your-domain.com",
  "cookies": [
    {
      "domain": ".your-domain.com",
      "name": "session_id",
      "value": "xxx",
      "path": "/",
      "expires": 1735689600,
      "secure": 1,
      "http_only": 1,
      "same_site": "lax"
    }
  ],
  "local_storage": {
    "access_token": "yyy",
    "user_id": "12345"
  },
  "ts": 1735000000000
}
```

响应体：
```json
{ "ok": true, "cookies": 12, "local_storage": 5 }
```

### GET /health

返回纯文本 `ok`，用于探活。

---

## 附录 C：完整启动脚本（Windows 示例）

`start.bat`：

```bat
@echo off
:: 1. 启动 Tauri（已经设了开机自启的话可省略）
start "" "%LOCALAPPDATA%\CookieBridge\cookie-bridge-app.exe"

:: 2. 等 1 秒让 HTTP server 起来
timeout /t 1 /nobreak >nul

:: 3. 启动 Go 业务程序
"%~dp0myapp.exe"
```

---

> **结论**：这套方案的核心是"SQLite + WAL 当成事实上的进程间消息总线"，Chrome 扩展只负责拉数据写入，Go 程序只读消费，Tauri 既是看门人又是 UI 出口。三者解耦干净，任何一端都可以独立改造、独立调试。
