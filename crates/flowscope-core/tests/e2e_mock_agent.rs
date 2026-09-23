//! 端到端集成：Engine × AcpExecutor × Store × EventHub × flowscope-mock-agent。
//!
//! 真实进程链路（非 MockExecutor）：registry 注册两个 agent —— `good` 跑
//! demo-script（完整成功回合），`bad` 跑 crash-script（prompt 中途 stderr + exit 3）。
//! 断言覆盖 M1 全链路契约：
//!
//! 1. 三节点线性工作流 collect → analyze(output_schema) → report 到终态 finished；
//! 2. 事件表齐全：run.started / 每节点 node.started + msg.delta + tool.update +
//!    node.finished / run.finished（外加 stderr → log.lines、plan.snapshot）；
//! 3. seq 从 1 起严格递增、无空洞；
//! 4. analyze 的 artifact "output" 存在且等于结构化提取结果；
//! 5. hub 快照与 store 落库事件数一致；
//! 6. crash 注入 → node.failed + run.failed，reason 携带 agent stderr 尾部行。
//!
//! 注：Engine 不在任何事件里回显渲染后的 prompt（模板注入只能由“严格未定义
//! 即失败”语义间接保证——三节点全部 finished 说明 params 与上游输出注入成功）。

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use flowscope_core::acp::registry::PermissionDefault;
use flowscope_core::acp::{AgentConfig, AgentRegistry};
use flowscope_core::engine::{AcpExecutor, Engine, NodeExecutor};
use flowscope_core::events::{EventKind, FsEvent};
use flowscope_core::hub::EventHub;
use flowscope_core::store::{RunRow, Store};
use serde_json::{Value, json};

fn mock_script(name: &str) -> String {
    format!(
        "{}/../flowscope-mock-agent/examples/{name}",
        env!("CARGO_MANIFEST_DIR")
    )
}

/// Locates the mock agent binary through `assert_cmd`. assert_cmd 2.x only
/// *locates* (`CARGO_BIN_EXE_*` / target-dir scan — cross-crate there is no
/// env var, so the workspace bin must already be built), so build it once per
/// test-binary run first; this also guarantees freshness instead of picking up
/// a stale `target/debug` artifact.（与 acp/session.rs 测试同款方案）
fn mock_exe() -> &'static str {
    static EXE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    EXE.get_or_init(|| {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());
        let status = std::process::Command::new(&cargo)
            .args([
                "build",
                "-p",
                "flowscope-mock-agent",
                "--bin",
                "flowscope-mock-agent",
            ])
            .status()
            .expect("spawn cargo build for the mock agent");
        assert!(
            status.success(),
            "cargo build -p flowscope-mock-agent failed"
        );
        assert_cmd::Command::cargo_bin("flowscope-mock-agent")
            .expect("locate flowscope-mock-agent after build")
            .get_program()
            .to_string_lossy()
            .into_owned()
    })
}

/// 一个 mock agent：同一 exe，按 key 绑定不同脚本（good/bad 双 agent 方案）。
fn mock_agent(key: &str, script: &str) -> AgentConfig {
    AgentConfig {
        key: key.into(),
        name: format!("Mock {key}"),
        command: vec![mock_exe().to_owned(), "--script".into(), script.to_owned()],
        cwd: None,
        env: BTreeMap::new(),
        default_mode: None,
        permission_default: PermissionDefault::Deny,
    }
}

/// good（demo-script，成功回合）+ bad（crash-script，失败注入）双 agent registry。
fn registry_good_and_bad() -> Arc<AgentRegistry> {
    let mut agents = BTreeMap::new();
    agents.insert(
        "good".to_owned(),
        mock_agent("good", &mock_script("demo-script.yaml")),
    );
    agents.insert(
        "bad".to_owned(),
        mock_agent("bad", &mock_script("crash-script.yaml")),
    );
    Arc::new(AgentRegistry { agents })
}

fn engine_with_mock_agents() -> (Arc<Store>, Arc<EventHub>, Arc<Engine>) {
    let store = Arc::new(Store::open_in_memory().unwrap());
    let hub = Arc::new(EventHub::new());
    let executor = Arc::new(AcpExecutor {
        registry: registry_good_and_bad(),
    });
    let engine = Arc::new(Engine::new(
        Arc::clone(&store),
        Arc::clone(&hub),
        executor as Arc<dyn NodeExecutor>,
    ));
    (store, hub, engine)
}

/// 轮询 store 直到 run 到终态（10ms 间隔，15s 上限）。
async fn wait_terminal(store: &Store, run_id: &str) -> RunRow {
    for _ in 0..1500 {
        if let Some(row) = store.get_run(run_id).unwrap() {
            if matches!(row.status.as_str(), "finished" | "failed" | "cancelled") {
                return row;
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("run {run_id} 15s 内未到终态");
}

/// 等批写任务把事件全部落库：计数连续两次（间隔 60ms > 50ms 窗口）稳定即认为冲刷完。
async fn drained_events(store: &Store, run_id: &str) -> Vec<FsEvent> {
    let read = |store: &Store| store.events_after(run_id, 0, 1_000_000).unwrap();
    let mut last = usize::MAX;
    for _ in 0..100 {
        let n = read(store).len();
        if n == last {
            return read(store);
        }
        last = n;
        tokio::time::sleep(Duration::from_millis(60)).await;
    }
    read(store)
}

/// 收集某节点某类事件的 payload 引用。
fn payloads_of<'a>(evs: &'a [FsEvent], kind: EventKind, node: &str) -> Vec<&'a Value> {
    evs.iter()
        .filter(|e| e.kind == kind && e.node_id.as_deref() == Some(node))
        .map(|e| &e.payload)
        .collect()
}

#[tokio::test]
async fn three_node_workflow_runs_end_to_end_with_full_event_chain() {
    // 模板全链路：params 注入 collect、collect 输出注入 analyze、
    // analyze 结构化输出注入 report（minijinja Strict：任何一环取不到值即渲染
    // 失败 → run failed，因此三节点 finished 即证明模板链生效）。
    let wf = flowscope_core::workflow::parse_yaml(
        r#"
meta: {name: e2e-demo, version: 1}
params: {topic: "fallback-topic"}
nodes:
  - {id: collect, agent: good, prompt: "收集 {{ params.topic }} 数据"}
  - id: analyze
    agent: good
    prompt: "分析 {{ nodes.collect.output.text }}"
    output_schema: {type: object, required: [ok], properties: {ok: {type: boolean}}}
  - {id: report, agent: good, prompt: "基于 {{ nodes.analyze.output.data_path }} 写报告"}
edges:
  - {from: collect, to: analyze}
  - {from: analyze, to: report}
"#,
    )
    .unwrap();
    let (store, hub, engine) = engine_with_mock_agents();

    let run_id = engine
        .start_run(wf, json!({"topic": "weekly-sales"}))
        .await
        .unwrap();
    let row = wait_terminal(&store, &run_id).await;
    assert_eq!(row.status, "finished");

    let evs = drained_events(&store, &run_id).await;
    assert!(!evs.is_empty(), "事件不能为空");
    assert!(evs.iter().all(|e| e.run_id == run_id));

    // (2) run 级事件齐全；入参覆盖默认参数后进入 run.started payload
    let started = evs
        .iter()
        .find(|e| e.kind == EventKind::RunStarted)
        .expect("run.started 事件");
    assert_eq!(started.payload["workflowName"], "e2e-demo");
    assert_eq!(started.payload["params"]["topic"], "weekly-sales");
    assert!(evs.iter().any(|e| e.kind == EventKind::RunFinished));

    // 每节点：node.started + msg.delta + tool.update + node.finished；
    // 另断言 stderr → log.lines 与 plan.snapshot 也走完全链路（demo-script 必产生）
    for node in ["collect", "analyze", "report"] {
        for kind in [
            EventKind::NodeStarted,
            EventKind::MsgDelta,
            EventKind::ToolUpdate,
            EventKind::NodeFinished,
            EventKind::LogLines,
            EventKind::PlanSnapshot,
        ] {
            assert!(
                !payloads_of(&evs, kind, node).is_empty(),
                "节点 {node} 缺少 {kind:?} 事件；events: {evs:?}"
            );
        }
    }

    // ACP 桥接事件带会话归因（session_id 由 AcpExecutor 注入）
    assert!(evs.iter().any(|e| e.kind == EventKind::MsgDelta
        && e.node_id.as_deref() == Some("analyze")
        && e.session_id.is_some()));

    // msg.delta 内容与 tool 生命周期穿透映射：t1 in_progress → completed
    let tool_states: Vec<&str> = payloads_of(&evs, EventKind::ToolUpdate, "collect")
        .iter()
        .map(|p| p["status"].as_str().unwrap_or_default())
        .collect();
    assert!(tool_states.contains(&"in_progress"), "{tool_states:?}");
    assert!(tool_states.contains(&"completed"), "{tool_states:?}");
    let completed = payloads_of(&evs, EventKind::ToolUpdate, "collect")
        .into_iter()
        .find(|p| p["status"] == "completed")
        .unwrap();
    assert_eq!(completed["toolCallId"], "t1");

    // stderr 行以 log.lines 抵达
    let logs = payloads_of(&evs, EventKind::LogLines, "collect");
    assert!(
        logs.iter().any(|p| p["lines"]
            .as_array()
            .is_some_and(|ls| ls.iter().any(|l| l == "mock agent starting"))),
        "log.lines 应含 mock stderr 行: {logs:?}"
    );

    // (3) seq 从 1 起严格递增且无空洞（store 按 seq 有序返回）
    let seqs: Vec<u64> = evs.iter().map(|e| e.seq).collect();
    let max = *seqs.last().unwrap();
    assert_eq!(
        seqs,
        (1..=max).collect::<Vec<u64>>(),
        "seq 必须为 1..={max} 连续无空洞"
    );

    // (4) analyze 的 artifact "output"：结构化提取后的 JSON
    let artifact = store
        .get_artifact(&run_id, "analyze", "output")
        .unwrap()
        .expect("analyze 节点应有 output artifact");
    let value: Value = serde_json::from_str(&artifact).unwrap();
    assert_eq!(value, json!({"ok": true, "data_path": "out/report.md"}));
    // 末节点同样落了 artifact（无 schema 节点包 text 壳）
    assert!(
        store
            .get_artifact(&run_id, "report", "output")
            .unwrap()
            .is_some()
    );

    // (5) hub 快照与 store 落库一致（drained 之后读）
    assert_eq!(
        hub.snapshot_after(&run_id, 0).len(),
        store.events_after(&run_id, 0, 10_000).unwrap().len(),
        "hub 与 store 事件数必须一致"
    );
}

#[tokio::test]
async fn crashed_agent_fails_node_and_run_with_stderr_detail() {
    let wf = flowscope_core::workflow::parse_yaml(
        r#"
meta: {name: e2e-crash, version: 1}
nodes:
  - {id: doomed, agent: bad, prompt: "跑吧"}
"#,
    )
    .unwrap();
    let (store, _hub, engine) = engine_with_mock_agents();

    let run_id = engine.start_run(wf, json!({})).await.unwrap();
    let row = wait_terminal(&store, &run_id).await;
    assert_eq!(row.status, "failed");

    let evs = drained_events(&store, &run_id).await;

    // node.failed + run.failed；无任何节点 finished
    let failed = payloads_of(&evs, EventKind::NodeFailed, "doomed")
        .into_iter()
        .next()
        .expect("doomed 的 node.failed 事件");
    assert!(
        evs.iter().any(|e| e.kind == EventKind::RunFailed),
        "缺 run.failed: {evs:?}"
    );
    assert!(
        evs.iter()
            .all(|e| e.kind != EventKind::NodeFinished && e.kind != EventKind::RunFinished),
        "失败 run 不得出现 finished 事件: {evs:?}"
    );
    assert!(failed["durationMs"].is_u64());

    // ProcessExit 细节穿透引擎：reason 含 stderr 尾部（crash-script 注入行）
    let reason = failed["reason"].as_str().unwrap_or_default();
    assert!(
        reason.contains("agent stderr tail"),
        "reason 应携带 stderr 尾部: {reason}"
    );
    assert!(
        reason.contains("crash_after reached after step 1"),
        "reason 应含 crash 注入行: {reason}"
    );

    // stderr 行同样以 log.lines 事件可见（启动行先于崩溃，确定性抵达）
    let logs = payloads_of(&evs, EventKind::LogLines, "doomed");
    assert!(
        logs.iter().any(|p| p["lines"]
            .as_array()
            .is_some_and(|ls| ls.iter().any(|l| l == "mock agent starting"))),
        "失败节点应有 log.lines 事件: {logs:?}"
    );

    // run.failed 的 reason 复述节点失败原因
    let run_failed = evs.iter().find(|e| e.kind == EventKind::RunFailed).unwrap();
    assert_eq!(run_failed.payload["reason"].as_str(), Some(reason));

    // 失败 run 同样保持 seq 连续
    let seqs: Vec<u64> = evs.iter().map(|e| e.seq).collect();
    let max = *seqs.last().unwrap();
    assert_eq!(seqs, (1..=max).collect::<Vec<u64>>());
}
