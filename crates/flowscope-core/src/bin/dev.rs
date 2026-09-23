//! 开发期启动器：bootstrap（home 目录组装）+ 示例工作流种子 + axum::serve。
//!
//! 参数（clap-free，支持 `--flag value` 与 `--flag=value`）：
//! - `--port N`：默认 39271
//! - `--home DIR`：默认 `target/dev-home`
//! - `--frontend-dist DIR`：可选；路径不存在则跳过静态托管并告警
//! - `--mock-agent-bin PATH`：可选；或环境变量 `FLOWSCOPE_MOCK_AGENT_BIN`；
//!   缺失时跳过 mock 注册（agents.toml 不生成，示例工作流将无 agent 可用）
//!
//! 种子：库中无工作流时写入 weekly-report（3 节点线性，agent `mock`）与
//! crash-demo（单节点，agent `bad-mock`，进程崩溃演示）。

use std::path::PathBuf;

use flowscope_core::api::{AppState, bootstrap};

const DEFAULT_PORT: u16 = 39271;

const WEEKLY_REPORT_YAML: &str = r#"# 示例：3 节点线性周报（collect → analyze → report，agent: mock）
meta: {name: weekly-report, version: 1}
params: {week: "W38"}
nodes:
  - {id: collect, agent: mock, prompt: "收集 {{ params.week }} 的原始数据"}
  - {id: analyze, agent: mock, prompt: "分析收集结果：{{ nodes.collect.output.text }}", output_schema: {type: object, required: [ok], properties: {ok: {type: boolean}}}}
  - {id: report, agent: mock, prompt: "基于分析撰写 {{ params.week }} 周报"}
edges:
  - {from: collect, to: analyze}
  - {from: analyze, to: report}
"#;

const CRASH_DEMO_YAML: &str = r#"# 示例：单节点崩溃演示（agent: bad-mock → 进程 exit(3)，重试 1 次）
meta: {name: crash-demo, version: 1}
nodes:
  - {id: boom, agent: bad-mock, prompt: "演示进程崩溃", retry: {max: 1, backoff_ms: 500}}
"#;

struct Args {
    port: u16,
    home: PathBuf,
    frontend_dist: Option<PathBuf>,
    mock_agent_bin: Option<PathBuf>,
}

fn usage_exit() -> ! {
    eprintln!(
        "用法: flowscope-dev [--port N] [--home DIR] [--frontend-dist DIR] [--mock-agent-bin PATH]\n\
         环境变量: FLOWSCOPE_MOCK_AGENT_BIN（mock agent 可执行文件路径）"
    );
    std::process::exit(2);
}

fn parse_args() -> Args {
    let mut port = DEFAULT_PORT;
    let mut home = PathBuf::from("target/dev-home");
    let mut frontend_dist = None;
    let mut mock_agent_bin = std::env::var_os("FLOWSCOPE_MOCK_AGENT_BIN").map(PathBuf::from);
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
            "--frontend-dist" => match value() {
                Some(v) => frontend_dist = Some(PathBuf::from(v)),
                None => usage_exit(),
            },
            "--mock-agent-bin" => match value() {
                Some(v) => mock_agent_bin = Some(PathBuf::from(v)),
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
        frontend_dist,
        mock_agent_bin,
    }
}

/// 库中无工作流时种入两个示例。
fn seed_workflows(state: &AppState) {
    let store = &state.store;
    let existing = match store.list_workflows() {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!(error = %e, "读取工作流列表失败，跳过种子");
            return;
        }
    };
    if !existing.is_empty() {
        tracing::info!(count = existing.len(), "已有工作流，跳过种子");
        return;
    }
    for (name, yaml) in [
        ("weekly-report", WEEKLY_REPORT_YAML),
        ("crash-demo", CRASH_DEMO_YAML),
    ] {
        match store.upsert_workflow(name, 1, yaml) {
            Ok(id) => println!("seeded workflow {name} ({id})"),
            Err(e) => tracing::warn!(error = %e, workflow = name, "种子工作流写入失败"),
        }
    }
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

    // 路径不存在 → 跳过并告警（前端开发期 dist 可尚未构建）
    let dist = args.frontend_dist.clone().filter(|p| p.exists());
    if args.frontend_dist.is_some() && dist.is_none() {
        tracing::warn!(
            dist = ?args.frontend_dist,
            "--frontend-dist 路径不存在，跳过静态托管"
        );
    }
    let mock_bin = args.mock_agent_bin.clone().filter(|p| p.exists());
    if args.mock_agent_bin.is_some() && mock_bin.is_none() {
        tracing::warn!(
            bin = ?args.mock_agent_bin,
            "--mock-agent-bin 路径不存在，跳过 mock agent 注册"
        );
    }

    let (state, router) = bootstrap(&args.home, mock_bin.clone(), dist.clone())
        .await
        .expect("bootstrap 失败");
    seed_workflows(&state);

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", args.port))
        .await
        .unwrap_or_else(|e| panic!("监听 127.0.0.1:{} 失败: {e}", args.port));
    println!(
        "FlowScope dev: http://127.0.0.1:{}  (home: {})",
        args.port,
        args.home.display()
    );
    if let Some(dist) = &dist {
        println!("frontend dist: {}", dist.display());
    }
    if mock_bin.is_none() {
        tracing::warn!(
            "未提供 mock agent（--mock-agent-bin 或 FLOWSCOPE_MOCK_AGENT_BIN）；\
             示例工作流引用的 mock/bad-mock 未注册，运行它们会失败"
        );
    }

    axum::serve(listener, router)
        .await
        .expect("axum serve 退出并报错");
}
