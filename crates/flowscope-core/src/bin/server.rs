//! 独立无头服务器（flowscope-server）：单文件分发形态——前端 UI 编译期嵌入
//! exe（见 [`flowscope_core::assets`]），目标机无需 Node/磁盘 dist，运行即
//! 打印带访问令牌的入口 URL，浏览器打开即用。
//!
//! 参数（clap-free，支持 `--flag value` 与 `--flag=value`，同 dev）：
//! - `--port N`：默认 8080
//! - `--home DIR`：默认 `~/.flowscope`（SQLite 与 agents.toml 所在）
//! - `--token T`：缺省**自动生成随机 16 hex** 并打印；`?token=` 与
//!   `Authorization: Bearer` 二者其一即可（见 api::bootstrap）
//! - `--workflow-dir DIR`：设置 `FLOWSCOPE_WORKFLOW_DIR`（文件夹工作流目录）
//!
//! mock agent 探测顺序：exe 同目录 `flowscope-mock-agent<EXE_SUFFIX>`（分发
//! 形态：与 server 同目录放置）→ `target/debug/`（工作区 cargo run 直跑）。
//! 找不到则 agents.toml 不自动生成（可手工编辑 `home/agents.toml` 注册）。
//! dist 恒为 None——静态请求一律走嵌入资源。

use std::fmt::Write as _;
use std::net::{IpAddr, ToSocketAddrs};
use std::path::PathBuf;

use flowscope_core::api::bootstrap;

const DEFAULT_PORT: u16 = 8080;

struct Args {
    port: u16,
    home: PathBuf,
    token: Option<String>,
    workflow_dir: Option<PathBuf>,
}

fn usage_exit() -> ! {
    eprintln!(
        "用法: flowscope-server [--port N] [--home DIR] [--token T] [--workflow-dir DIR]\n\
         默认: port=8080 home=~/.flowscope token=自动生成(打印) workflow-dir=env/默认目录"
    );
    std::process::exit(2);
}

fn parse_args() -> Args {
    let mut port = DEFAULT_PORT;
    let mut home = default_home();
    let mut token = None;
    let mut workflow_dir = None;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let (key, inline) = match arg.split_once('=') {
            Some((k, v)) => (k.to_owned(), Some(v.to_owned())),
            None => (arg, None),
        };
        let mut value = || inline.clone().or_else(|| it.next());
        match key.as_str() {
            "--port" => match value().and_then(|v| v.parse::<u16>().ok()) {
                Some(p) => port = p,
                None => {
                    eprintln!("--port 需要一个有效的 u16");
                    usage_exit();
                }
            },
            "--home" => match value() {
                Some(v) => home = PathBuf::from(v),
                None => usage_exit(),
            },
            "--token" => match value() {
                Some(v) if !v.is_empty() => token = Some(v),
                _ => usage_exit(),
            },
            "--workflow-dir" => match value() {
                Some(v) => workflow_dir = Some(PathBuf::from(v)),
                None => usage_exit(),
            },
            _ => {
                eprintln!("未知参数: {key}");
                usage_exit();
            }
        }
    }
    Args {
        port,
        home,
        token,
        workflow_dir,
    }
}

/// `~/.flowscope`：Windows 用 USERPROFILE，Unix 用 HOME；都缺失回退 `.`。
fn default_home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".flowscope")
}

/// 随机 16 hex token（std-only）：时间纳秒 ^ 进程 ID ^ ASLR 栈地址熵，经
/// splitmix64 雪崩后取低 64 位。分发形态不引额外依赖，唯一性要求仅
/// 「同机多次启动不撞车」，时间+pid+地址熵远超足够。
fn random_token() -> String {
    fn splitmix64(state: &mut u64) -> u64 {
        *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = *state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    let anchor = 0u8; // 取其栈地址作 ASLR 熵源
    let mut state = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x0123_4567_89AB_CDEF)
        ^ ((std::process::id() as u64) << 32)
        ^ (&anchor as *const u8 as u64);
    let bits = splitmix64(&mut state);
    let _ = splitmix64(&mut state); // 再搅一步，避免首步输出与种子弱相关
    format!("{bits:016x}")
}

/// mock agent 探测：exe 同目录 → `target/debug/`（相对工作目录）。
fn probe_mock_bin() -> Option<PathBuf> {
    let name = format!("flowscope-mock-agent{}", std::env::consts::EXE_SUFFIX);
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(&name));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("target").join("debug").join(&name));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// 本机全部 IPv4（std-only）：恒含 127.0.0.1，再尝试解析本机主机名
/// （COMPUTERNAME/HOSTNAME）拿各网卡地址；解析失败不影响启动（仅少打印
/// 几行 LAN 入口）。
fn local_ipv4s() -> Vec<IpAddr> {
    let mut out = vec![IpAddr::from([127, 0, 0, 1])];
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok();
    if let Some(host) = host {
        if let Ok(addrs) = (host.as_str(), 0u16).to_socket_addrs() {
            for a in addrs {
                let ip = a.ip();
                if ip.is_ipv4() && !out.contains(&ip) {
                    out.push(ip);
                }
            }
        }
    }
    out
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    let args = parse_args();

    let token = args.token.clone().unwrap_or_else(random_token);
    if let Some(dir) = &args.workflow_dir {
        // SAFETY: server main 单线程初始化阶段，serve 尚未开始
        unsafe { std::env::set_var("FLOWSCOPE_WORKFLOW_DIR", dir) };
    }

    let mock_bin = probe_mock_bin();
    if mock_bin.is_none() {
        tracing::warn!(
            "未找到 flowscope-mock-agent（exe 同目录 / target/debug）；\
             agents.toml 不会自动生成，可手工编辑 home/agents.toml 注册 agent"
        );
    }

    let (state, router) = bootstrap(
        &args.home,
        mock_bin.clone(),
        None,
        Some(token.clone().into()),
    )
    .await
    .unwrap_or_else(|e| panic!("bootstrap 失败: {e}"));
    let _ = &state;

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", args.port))
        .await
        .unwrap_or_else(|e| panic!("监听 0.0.0.0:{} 失败: {e}", args.port));

    println!("FlowScope server 已启动（前端 UI 内嵌，无需磁盘 dist）");
    println!(
        "home: {}  mock agent: {}",
        args.home.display(),
        mock_bin
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "未找到".into())
    );
    if let Some(dir) = &args.workflow_dir {
        println!("workflow-dir: {}", dir.display());
    }
    println!("访问入口（令牌即访问凭据，可 Ctrl+C 停止）:");
    for ip in local_ipv4s() {
        let mut url = format!("  http://{ip}:{}", args.port);
        let _ = write!(url, "/?token={token}");
        println!("{url}");
    }

    axum::serve(listener, router)
        .await
        .expect("axum serve 退出并报错");
}
