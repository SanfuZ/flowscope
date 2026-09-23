//! FlowScope 桌面壳（Tauri 2，M1 交付形态）。
//!
//! 架构：桌面进程内直接组装 flowscope-core 后端（复用
//! [`flowscope_core::api::bootstrap`]——建 SQLite/EventHub/AgentRegistry/Engine，
//! 并托管 `frontend/dist` 静态资源），绑定 `127.0.0.1:<随机端口>`，随后创建
//! WebView 窗口直连该地址。无外部进程、无跨进程通信。
//!
//! - home：`~/.flowscope`（库、agents.toml、脚本均落在此）。
//! - mock agent：环境变量 `FLOWSCOPE_MOCK_AGENT_BIN` 优先；否则探测
//!   `<workspace 根>/target/debug/flowscope-mock-agent.exe`（workspace 根 =
//!   本 crate 目录三级向上，编译期由 `CARGO_MANIFEST_DIR` 定位）。找不到则
//!   告警并跳过注册（agents.toml 不生成，用户可手写）。
//! - 端口：默认随机（`:0`）；设 `FLOWSCOPE_DESKTOP_PORT` 可固定端口（便于
//!   自动化验证）。实际端口总是打印到 stdout。
//! - 探活：`TcpStream::connect` 轮询至多 3s，成功即认为服务就绪。
//!
//! M1 注意：`bundle.active=false`（不出安装包）；图标为 32x32 占位 PNG，
//! 正式图标与三平台打包进 CI 是 M2 范畴。Windows 依赖系统预装的 WebView2
//! 运行时（Win10/11 更新后自带）；若缺失，窗口创建会失败——M1 不内嵌
//! bootstrapper，报告即可。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::time::Duration;

use flowscope_core::api::bootstrap;
use tauri::{WebviewUrl, WebviewWindowBuilder};

/// workspace 根：`<root>/apps/desktop/src-tauri` 三级向上（编译期解析）。
fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("本 crate 应位于 <workspace>/apps/desktop/src-tauri")
        .to_path_buf()
}

/// 定位 mock agent：`FLOWSCOPE_MOCK_AGENT_BIN` 优先（须存在），
/// 否则探测 `target/debug/flowscope-mock-agent(.exe)`。
fn locate_mock_agent(root: &Path) -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("FLOWSCOPE_MOCK_AGENT_BIN") {
        let p = PathBuf::from(explicit);
        if p.is_file() {
            return Some(p);
        }
        eprintln!(
            "[flowscope] FLOWSCOPE_MOCK_AGENT_BIN 指向的文件不存在，忽略: {}",
            p.display()
        );
    }
    let debug = root
        .join("target")
        .join("debug")
        .join("flowscope-mock-agent");
    let candidates = [debug.with_extension("exe"), debug];
    candidates.into_iter().find(|p| p.is_file())
}

fn main() {
    // 日志初始化：fmt 默认写 stderr（release 的 windows_subsystem 隐藏控制台，
    // 仍可重定向）；级别由 RUST_LOG 控制，缺省 info。须在任何 core 日志前调用。
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()))
        .init();

    let home = dirs::home_dir()
        .expect("无法确定用户 home 目录")
        .join(".flowscope");
    std::fs::create_dir_all(&home)
        .unwrap_or_else(|e| panic!("创建 home 目录 {} 失败: {e}", home.display()));

    let root = workspace_root();
    let mock_agent = locate_mock_agent(&root);
    if mock_agent.is_none() {
        eprintln!(
            "[flowscope] 未找到 mock agent（可设 FLOWSCOPE_MOCK_AGENT_BIN，或先 \
             cargo build -p flowscope-mock-agent）；首启不生成 agents.toml"
        );
    }
    let dist = root.join("frontend").join("dist");
    let dist = dist.is_dir().then_some(dist);

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("创建 tokio runtime 失败");

    let port = rt.block_on(async {
        let (_state, router) = bootstrap(&home, mock_agent.clone(), dist.clone())
            .await
            .expect("bootstrap 组装失败");

        // 端口：FLOWSCOPE_DESKTOP_PORT 固定（自动化验证用），缺省随机
        let bind_port = match std::env::var("FLOWSCOPE_DESKTOP_PORT") {
            Ok(s) => match s.parse::<u16>() {
                Ok(p) => p,
                Err(_) => {
                    eprintln!("[flowscope] FLOWSCOPE_DESKTOP_PORT={s} 不是有效 u16，改用随机端口");
                    0
                }
            },
            Err(_) => 0,
        };
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", bind_port))
            .await
            .unwrap_or_else(|e| panic!("监听 127.0.0.1:{bind_port} 失败: {e}"));
        let port = listener.local_addr().expect("获取本地监听地址失败").port();
        // rt 存活至 main 结束（窗口关闭），axum 服务随之存活
        tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, router).await {
                panic!("axum serve 退出并报错: {e}");
            }
        });

        // 探活：连接成功即认为 accept 就绪（至多 3s）
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
                Ok(_) => break,
                Err(_) if tokio::time::Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(e) => panic!("本地服务探活失败（3s，端口 {port}）: {e}"),
            }
        }
        port
    });
    // 无条件打印（release 下 windows_subsystem 隐藏控制台，stdout 仍可重定向）
    println!(
        "FlowScope desktop: http://127.0.0.1:{port}/  (home: {})",
        home.display()
    );

    tauri::Builder::default()
        .setup(move |app| {
            let url = format!("http://127.0.0.1:{port}/")
                .parse()
                .expect("本地 URL 解析失败");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("FlowScope")
                .inner_size(1440.0, 900.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
