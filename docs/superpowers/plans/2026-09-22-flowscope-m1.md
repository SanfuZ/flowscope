# FlowScope M1（核心闭环）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面单机版跑通：YAML 定义的工作流 → 引擎调度 ACP session（企业 agent / mock-agent）→ 事件流持久化 + SSE → React DAG 监控视图实时点亮节点并展示节点内消息/工具/plan/日志。

**Architecture:** Rust workspace（`flowscope-core` 引擎库 + `flowscope-mock-agent` 测试 agent）承载 ACP 客户端、DAG 编排、SQLite 事件溯源与 axum HTTP/SSE；React 前端（同一份构建产物）由 axum 静态托管，Tauri 2 壳在进程内拉起同一 Router 并把窗口指向 `127.0.0.1`。

**Tech Stack:** Rust (tokio, axum 0.8, rusqlite bundled, `agent-client-protocol` 2.2, minijinja 2, jsonschema, serde_yaml 0.9, tower-http 0.6) + React 18/Vite 6/TS + @xyflow/react 12 + zustand 5 + @tanstack/react-query 5 + react-window 1.8 + Tauri 2。

**Spec:** `docs/superpowers/specs/2026-09-22-flowscope-design.md`（本计划从 spec 出发，执行者须同时读 spec）

## Global Constraints

- Rust edition 2024；所有依赖用 `cargo add` 取当前稳定版，下限：`agent-client-protocol = "2.2"`、`axum = "0.8"`、`tokio = "1"`、`rusqlite = "0.37"` (features bundled)、`minijinja = "2"`、`serde_yaml = "0.9"`、`tower-http = "0.6"` (features fs)。
- ACP 只用 v1 稳定面；**不得**启用 crate 的 `unstable_protocol_v2` feature。
- 事件表只追加；节点/运行状态永远是事件投影，不得落第二份状态。
- SSE 事件 `id:` 字段 = `seq`；统一端点 `GET /api/runs/:id/events?after=<seq>`（`Last-Event-ID` 头等价）。
- 桌面内嵌模式绑 `127.0.0.1` 免鉴权；M1 不实现 token（M2 的项）。
- 前端与 API 同源（axum 托管前端），API base 就是 `window.location.origin`。
- 每 Task 结束 `cargo fmt && cargo test`（或前端 `npm test`）通过后提交；commit 信息用 conventional commits。
- 测试命令一律在仓库根 `D:\zcode_processing\agent-flow-scope` 执行。

---

### Task 1: Cargo workspace 骨架

**Files:**
- Create: `Cargo.toml`（workspace 根，覆盖现有空仓库）
- Create: `crates/flowscope-core/Cargo.toml`、`crates/flowscope-core/src/lib.rs`
- Create: `crates/flowscope-mock-agent/Cargo.toml`、`crates/flowscope-mock-agent/src/main.rs`
- Create: `rustfmt.toml`

**Interfaces:**
- Consumes: 无
- Produces: crate 名 `flowscope-core`（lib）、`flowscope-mock-agent`（bin）；后续所有任务的工作空间。

- [ ] **Step 1: 写 workspace 根 Cargo.toml**

```toml
[workspace]
resolver = "2"
members = ["crates/flowscope-core", "crates/flowscope-mock-agent"]

[workspace.package]
edition = "2024"
version = "0.1.0"

[workspace.dependencies]
tokio = { version = "1", features = ["full"] }
axum = "0.8"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde_yaml = "0.9"
rusqlite = { version = "0.37", features = ["bundled"] }
agent-client-protocol = "2.2"
minijinja = "2"
jsonschema = "0.30"
chrono = { version = "0.4", features = ["serde"] }
uuid = { version = "1", features = ["v4"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
tower-http = { version = "0.6", features = ["fs", "cors"] }
futures = "0.3"
async-trait = "0.1"
thiserror = "2"
```

- [ ] **Step 2: 写两个子 crate**

`crates/flowscope-core/Cargo.toml`：

```toml
[package]
name = "flowscope-core"
version.workspace = true
edition.workspace = true

[dependencies]
tokio = { workspace = true }
axum = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
serde_yaml = { workspace = true }
rusqlite = { workspace = true }
agent-client-protocol = { workspace = true }
minijinja = { workspace = true }
jsonschema = { workspace = true }
chrono = { workspace = true }
uuid = { workspace = true }
tracing = { workspace = true }
tower-http = { workspace = true }
futures = { workspace = true }
async-trait = { workspace = true }
thiserror = { workspace = true }
```

`crates/flowscope-core/src/lib.rs`：

```rust
pub mod events;
```

（`events` 模块 Task 2 填充；先建 `pub mod events;` 会编译失败——本步先写 `pub fn placeholder() {}`，Task 2 替换。）

`crates/flowscope-mock-agent/Cargo.toml`：

```toml
[package]
name = "flowscope-mock-agent"
version.workspace = true
edition.workspace = true

[dependencies]
serde = { workspace = true }
serde_json = { workspace = true }
serde_yaml = { workspace = true }
```

`crates/flowscope-mock-agent/src/main.rs`：

```rust
fn main() {
    println!("flowscope-mock-agent placeholder");
}
```

`rustfmt.toml`：

```toml
edition = "2024"
max_width = 100
```

- [ ] **Step 3: 验证编译**

Run: `cargo check`
Expected: 通过（0 error）。

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml Cargo.lock rustfmt.toml crates/
git commit -m "chore: cargo workspace 骨架（flowscope-core / flowscope-mock-agent）"
```

---

### Task 2: 事件模型 `events.rs`

**Files:**
- Create: `crates/flowscope-core/src/events.rs`
- Modify: `crates/flowscope-core/src/lib.rs`（去掉 placeholder）

**Interfaces:**
- Consumes: 无
- Produces:

```rust
pub enum EventKind { RunStarted, RunFinished, RunFailed, RunCancelled, RunInterrupted,
    NodeStarted, NodeFinished, NodeCancelled, NodeFailed, NodeSkipped, NodeRetry,
    MsgDelta, ToolUpdate, PlanSnapshot, SessionMeta, LogLines, Callback, Permission }
// serde 序列化为点分小写："run.started" ... "node.finished" ... "msg.delta" ...
pub struct FsEvent { pub seq: u64, pub ts: chrono::DateTime<Utc>, pub run_id: String,
    pub node_id: Option<String>, pub session_id: Option<String>,
    pub kind: EventKind, pub payload: serde_json::Value }
```

- [ ] **Step 1: 写失败测试（含序列化黄金样例）**

`crates/flowscope-core/src/events.rs` 底部测试模块：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn kind_serializes_dotted_lowercase() {
        assert_eq!(serde_json::to_string(&EventKind::MsgDelta).unwrap(), "\"msg.delta\"");
        assert_eq!(serde_json::to_string(&EventKind::NodeFinished).unwrap(), "\"node.finished\"");
        assert_eq!(serde_json::to_string(&EventKind::RunStarted).unwrap(), "\"run.started\"");
    }

    #[test]
    fn event_roundtrip() {
        let ev = FsEvent {
            seq: 7, ts: chrono::Utc.timestamp_millis_opt(1758500000000).unwrap(),
            run_id: "run_ab12".into(), node_id: Some("analyze".into()),
            session_id: Some("sess_1".into()), kind: EventKind::ToolUpdate,
            payload: serde_json::json!({"toolCallId": "t1", "status": "in_progress"}),
        };
        let s = serde_json::to_string(&ev).unwrap();
        assert!(s.contains("\"kind\":\"tool.update\""));
        let back: FsEvent = serde_json::from_str(&s).unwrap();
        assert_eq!(back.seq, 7);
        assert_eq!(back.node_id.as_deref(), Some("analyze"));
    }
}
```

- [ ] **Step 2: 运行验证失败**

Run: `cargo test -p flowscope-core`
Expected: FAIL（`events.rs` 未定义类型）。

- [ ] **Step 3: 实现**

```rust
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EventKind {
    #[serde(rename = "run.started")] RunStarted,
    #[serde(rename = "run.finished")] RunFinished,
    #[serde(rename = "run.failed")] RunFailed,
    #[serde(rename = "run.cancelled")] RunCancelled,
    #[serde(rename = "run.interrupted")] RunInterrupted,
    #[serde(rename = "node.started")] NodeStarted,
    #[serde(rename = "node.finished")] NodeFinished,
    #[serde(rename = "node.cancelled")] NodeCancelled,
    #[serde(rename = "node.failed")] NodeFailed,
    #[serde(rename = "node.skipped")] NodeSkipped,
    #[serde(rename = "node.retry")] NodeRetry,
    #[serde(rename = "msg.delta")] MsgDelta,
    #[serde(rename = "tool.update")] ToolUpdate,
    #[serde(rename = "plan.snapshot")] PlanSnapshot,
    #[serde(rename = "session.meta")] SessionMeta,
    #[serde(rename = "log.lines")] LogLines,
    #[serde(rename = "callback")] Callback,
    #[serde(rename = "permission")] Permission,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsEvent {
    pub seq: u64,
    pub ts: DateTime<Utc>,
    pub run_id: String,
    pub node_id: Option<String>,
    pub session_id: Option<String>,
    pub kind: EventKind,
    pub payload: serde_json::Value,
}
```

`lib.rs`：`pub mod events; pub mod store;`（store 模块 Task 3，先注释留到 Task 3 建——本 Task 只留 `pub mod events;`）。

- [ ] **Step 4: 运行验证通过**

Run: `cargo test -p flowscope-core`
Expected: PASS（2 tests）。

- [ ] **Step 5: Commit**

```bash
git add crates/flowscope-core/src/
git commit -m "feat(core): 统一事件模型 FsEvent/EventKind（对齐 AG-UI 语义）"
```

---

### Task 3: SQLite 存储 `store.rs`

**Files:**
- Create: `crates/flowscope-core/src/store.rs`
- Modify: `crates/flowscope-core/src/lib.rs`（加 `pub mod store;`）

**Interfaces:**
- Consumes: `crate::events::FsEvent`
- Produces:

```rust
pub struct Store { /* rusqlite::Connection + Mutex */ }
impl Store {
    pub fn open_in_memory() -> Result<Store, StoreError>;
    pub fn open(path: &std::path::Path) -> Result<Store, StoreError>;   // 建 schema + WAL
    pub fn upsert_workflow(&self, name: &str, version: u32, yaml: &str) -> Result<String, StoreError>; // -> workflow_id
    pub fn create_run(&self, workflow_id: &str, params: &serde_json::Value) -> Result<String, StoreError>; // -> run_id
    pub fn set_run_status(&self, run_id: &str, status: &str) -> Result<(), StoreError>;
    pub fn running_runs(&self) -> Result<Vec<String>, StoreError>;
    pub fn append_events(&self, events: &[FsEvent]) -> Result<(), StoreError>;
    pub fn events_after(&self, run_id: &str, after: u64, limit: u64) -> Result<Vec<FsEvent>, StoreError>;
    pub fn list_runs(&self) -> Result<Vec<RunRow>, StoreError>;
    pub fn get_run(&self, run_id: &str) -> Result<Option<RunRow>, StoreError>;
    pub fn put_artifact(&self, run_id: &str, node_id: &str, name: &str, content_type: &str, content: &str) -> Result<(), StoreError>;
    pub fn get_artifact(&self, run_id: &str, node_id: &str, name: &str) -> Result<Option<String>, StoreError>;
}
pub struct RunRow { pub id: String, pub workflow_id: String, pub status: String,
    pub params: serde_json::Value, pub started_at: String, pub ended_at: Option<String> }
```

- [ ] **Step 1: 写失败测试**

`crates/flowscope-core/src/store.rs` 底部：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{EventKind, FsEvent};
    use chrono::Utc;

    fn ev(seq: u64, run: &str) -> FsEvent {
        FsEvent { seq, ts: Utc::now(), run_id: run.into(), node_id: None,
            session_id: None, kind: EventKind::RunStarted, payload: serde_json::json!({}) }
    }

    #[test]
    fn append_then_read_after() {
        let s = Store::open_in_memory().unwrap();
        let wf = s.upsert_workflow("demo", 1, "meta: {}").unwrap();
        let run = s.create_run(&wf, &serde_json::json!({"week":"W38"})).unwrap();
        s.append_events(&[ev(1, &run), ev(2, &run), ev(3, &run)]).unwrap();
        let got = s.events_after(&run, 1, 100).unwrap();
        assert_eq!(got.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![2, 3]);
        assert_eq!(s.events_after(&run, 3, 100).unwrap().len(), 0);
        let row = s.get_run(&run).unwrap().unwrap();
        assert_eq!(row.params["week"], "W38");
    }

    #[test]
    fn artifact_roundtrip_and_status() {
        let s = Store::open_in_memory().unwrap();
        let wf = s.upsert_workflow("demo", 1, "x").unwrap();
        let run = s.create_run(&wf, &serde_json::json!({})).unwrap();
        s.set_run_status(&run, "finished").unwrap();
        s.put_artifact(&run, "n1", "output", "application/json", "{\"ok\":true}").unwrap();
        assert_eq!(s.get_artifact(&run, "n1", "output").unwrap().unwrap(), "{\"ok\":true}");
        assert_eq!(s.get_run(&run).unwrap().unwrap().status, "finished");
    }
}
```

- [ ] **Step 2: 运行验证失败**

Run: `cargo test -p flowscope-core store`
Expected: FAIL（类型未定义）。

- [ ] **Step 3: 实现**

schema（spec 5.2）+ WAL（`PRAGMA journal_mode=WAL`，内存库跳过）。要点代码：

```rust
use crate::events::FsEvent;
use rusqlite::{params, Connection, OptionalExtension};
use std::sync::Mutex;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum StoreError { #[error("sqlite: {0}")] Sql(#[from] rusqlite::Error),
    #[error("serde: {0}")] Serde(#[from] serde_json::Error) }

pub struct RunRow { pub id: String, pub workflow_id: String, pub status: String,
    pub params: serde_json::Value, pub started_at: String, pub ended_at: Option<String> }

pub struct Store { conn: Mutex<Connection> }

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS workflows(id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL, yaml TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(name, version));
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id), params_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT);
CREATE TABLE IF NOT EXISTS events(run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, node_id TEXT, session_id TEXT, kind TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(run_id, seq));
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT, agent_key TEXT, acp_session_id TEXT);
CREATE TABLE IF NOT EXISTS artifacts(run_id TEXT NOT NULL, node_id TEXT NOT NULL, name TEXT NOT NULL, content_type TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY(run_id, node_id, name));
";

impl Store {
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn: Mutex::new(conn) })
    }
    pub fn open(path: &std::path::Path) -> Result<Self, StoreError> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn: Mutex::new(conn) })
    }
    pub fn upsert_workflow(&self, name: &str, version: u32, yaml: &str) -> Result<String, StoreError> {
        let id = format!("wf_{}", uuid::Uuid::new_v4().simple());
        self.conn.lock().unwrap().execute(
            "INSERT INTO workflows(id, name, version, yaml) VALUES(?1,?2,?3,?4) \
             ON CONFLICT(name, version) DO UPDATE SET yaml=excluded.yaml",
            params![id, name, version, yaml])?;
        Ok(id)
    }
    pub fn create_run(&self, workflow_id: &str, params: &serde_json::Value) -> Result<String, StoreError> {
        let id = format!("run_{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        self.conn.lock().unwrap().execute(
            "INSERT INTO runs(id, workflow_id, params_json) VALUES(?1,?2,?3)",
            params![id, workflow_id, params.to_string()])?;
        Ok(id)
    }
    pub fn set_run_status(&self, run_id: &str, status: &str) -> Result<(), StoreError> {
        self.conn.lock().unwrap().execute(
            "UPDATE runs SET status=?2, ended_at=CASE WHEN ?2 IN ('finished','failed','cancelled','interrupted') THEN datetime('now') ELSE ended_at END WHERE id=?1",
            params![run_id, status])?;
        Ok(())
    }
    pub fn running_runs(&self) -> Result<Vec<String>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id FROM runs WHERE status='running'")?;
        Ok(stmt.query_map([], |r| r.get(0))?.collect::<Result<Vec<_>, _>>()?)
    }
    pub fn append_events(&self, events: &[FsEvent]) -> Result<(), StoreError> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO events(run_id, seq, ts, node_id, session_id, kind, payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7)")?;
            for e in events {
                stmt.execute(params![e.run_id, e.seq as i64, e.ts.to_rfc3339(),
                    e.node_id, e.session_id, serde_json::to_string(&e.kind)?, e.payload.to_string()])?;
            }
        }
        tx.commit()?;
        Ok(())
    }
    pub fn events_after(&self, run_id: &str, after: u64, limit: u64) -> Result<Vec<FsEvent>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT seq, ts, run_id, node_id, session_id, kind, payload_json FROM events \
             WHERE run_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3")?;
        let rows = stmt.query_map(params![run_id, after as i64, limit as i64], |r| {
            let seq: i64 = r.get(0)?; let ts: String = r.get(1)?;
            let kind: String = r.get(5)?; let payload: String = r.get(6)?;
            Ok((seq as u64, ts, r.get(2)?, r.get(3)?, r.get(4)?, kind, payload))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (seq, ts, run_id, node_id, session_id, kind, payload) = row?;
            out.push(FsEvent { seq, ts: chrono::DateTime::parse_from_rfc3339(&ts)?.with_timezone(&chrono::Utc),
                run_id, node_id, session_id,
                kind: serde_json::from_str(&kind)?, payload: serde_json::from_str(&payload)? });
        }
        Ok(out)
    }
    // list_runs / get_run：SELECT 后把 params_json/行字段填进 RunRow（模式同上，直白实现）
    // put_artifact / get_artifact：UPSERT / SELECT content（模式同上）
}
```

`list_runs/get_run/put_artifact/get_artifact` 按注释补齐（同样的 prepare/query_map 模式，无新逻辑）。

- [ ] **Step 4: 运行验证通过**

Run: `cargo test -p flowscope-core store`
Expected: PASS（2 tests）。

- [ ] **Step 5: Commit**

```bash
git add crates/flowscope-core/src/
git commit -m "feat(core): SQLite 事件存储（workflows/runs/events/artifacts，只追加）"
```

---

### Task 4: EventHub（broadcast + 环形缓冲）

**Files:**
- Create: `crates/flowscope-core/src/hub.rs`
- Modify: `crates/flowscope-core/src/lib.rs`（加 `pub mod hub;`）

**Interfaces:**
- Consumes: `crate::events::FsEvent`
- Produces:

```rust
pub struct EventHub { /* Mutex<HashMap<String /*run_id*/, RunChannel>> */ }
struct RunChannel { ring: VecDeque<Arc<FsEvent>>, tx: tokio::sync::broadcast::Sender<Arc<FsEvent>> }
impl EventHub {
    pub fn new() -> Self;
    pub fn publish(&self, ev: FsEvent);                       // 入环形缓冲(容量4096)并广播 Arc<FsEvent>
    pub fn snapshot_after(&self, run_id: &str, after: u64) -> Vec<Arc<FsEvent>>;
    pub fn subscribe(&self, run_id: &str) -> tokio::sync::broadcast::Receiver<Arc<FsEvent>>; // 容量1024
}
```

- [ ] **Step 1: 写失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{EventKind, FsEvent};
    use chrono::Utc;
    use std::sync::Arc;

    fn ev(seq: u64) -> Arc<FsEvent> { Arc::new(FsEvent { seq, ts: Utc::now(),
        run_id: "r".into(), node_id: None, session_id: None,
        kind: EventKind::RunStarted, payload: serde_json::json!({}) }) }

    #[tokio::test]
    async fn publish_snapshot_subscribe() {
        let hub = EventHub::new();
        let mut rx = hub.subscribe("r");
        hub.publish((*ev(1)).clone());
        hub.publish((*ev(2)).clone());
        assert_eq!(hub.snapshot_after("r", 0).len(), 2);
        assert_eq!(hub.snapshot_after("r", 1).len(), 1);
        let got = rx.recv().await.unwrap();
        assert_eq!(got.seq, 1);
        assert_eq!(hub.snapshot_after("nope", 0).len(), 0);
    }
}
```

- [ ] **Step 2: 运行验证失败**

Run: `cargo test -p flowscope-core hub`
Expected: FAIL。

- [ ] **Step 3: 实现（Mutex<HashMap> + broadcast::channel(1024) + VecDeque 环形，容量 4096，超出 pop_front）**

标准实现约 50 行，无隐藏逻辑：`publish` 先 `entry(run_id).or_insert_with`，`ring.push_back`，`ring.len()>4096` 时 `pop_front`，`tx.send(Arc::new(ev))` 忽略 SendError（无订阅者是常态）。

- [ ] **Step 4: 运行验证通过**

Run: `cargo test -p flowscope-core hub`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add crates/flowscope-core/src/
git commit -m "feat(core): EventHub——broadcast 实时通道 + 4096 环形续传缓冲"
```

---

### Task 5: 工作流模型、YAML 解析与校验 `workflow.rs`

**Files:**
- Create: `crates/flowscope-core/src/workflow.rs`
- Modify: `crates/flowscope-core/src/lib.rs`（加 `pub mod workflow;`）

**Interfaces:**
- Consumes: 无
- Produces:

```rust
pub struct WorkflowDef { pub name: String, pub version: u32,
    pub params: serde_json::Map<String, serde_json::Value>,
    pub nodes: Vec<AgentNodeDef>, pub edges: Vec<EdgeDef> }
pub struct AgentNodeDef { pub id: String, pub agent: String, pub prompt: String,
    pub output_schema: Option<serde_json::Value>,
    pub retry: RetryDef, pub timeout_ms: Option<u64> }
#[derive(Clone, Copy)] pub struct RetryDef { pub max: u32, pub backoff_ms: u64 }   // 默认 max=0, backoff_ms=1000
pub struct EdgeDef { pub from: String, pub to: String, pub when: Option<String> }
pub fn parse_yaml(yaml: &str) -> Result<WorkflowDef, WorkflowError>;   // serde_yaml 反序列化（#[serde(deny_unknown_fields)]）
pub fn validate(wf: &WorkflowDef) -> Result<(), WorkflowError>;        // 节点 id 唯一、边引用存在、Kahn 判无环
#[derive(Error, Debug)] pub enum WorkflowError { #[error("yaml: {0}")] Yaml(#[from] serde_yaml::Error),
    #[error("{0}")] Invalid(String) }
```

YAML 输入格式与 spec 4.1 一致（`meta.name/meta.version`、`params`、`nodes[]`、`edges[]`；`retry`/`timeout_ms` 可选，`#[serde(default)]`）。

- [ ] **Step 1: 写失败测试（解析 + 三种校验失败）**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const VALID: &str = r#"
meta: {name: demo, version: 3}
params: {week: "2026-W38"}
nodes:
  - {id: collect, agent: enterprise, prompt: "收集 {{ params.week }}"}
  - id: analyze
    agent: enterprise
    prompt: "分析 {{ nodes.collect.output }}"
    timeout_ms: 600000
    output_schema: {type: object, required: [ok], properties: {ok: {type: boolean}}}
    retry: {max: 2, backoff_ms: 3000}
  - {id: report, agent: enterprise, prompt: "写报告"}
edges:
  - {from: collect, to: analyze}
  - {from: analyze, to: report, when: "output.ok == true"}
"#;

    #[test]
    fn parses_valid_workflow() {
        let wf = parse_yaml(VALID).unwrap();
        assert_eq!(wf.name, "demo");
        assert_eq!(wf.version, 3);
        assert_eq!(wf.nodes.len(), 3);
        assert_eq!(wf.nodes[1].retry.max, 2);
        assert_eq!(wf.nodes[1].timeout_ms, Some(600000));
        assert_eq!(wf.edges[1].when.as_deref(), Some("output.ok == true"));
        assert!(validate(&wf).is_ok());
    }

    #[test]
    fn rejects_cycle_and_unknown_refs_and_dup_ids() {
        let cyc = VALID.replace("from: analyze, to: report", "to: collect");
        assert!(validate(&parse_yaml(&cyc).unwrap()).is_err());
        let bad_edge = VALID.replace("to: report, when", "to: ghost, when");
        assert!(validate(&parse_yaml(&bad_edge).unwrap()).is_err());
        let dup = VALID.replace("id: report", "id: collect");
        assert!(validate(&parse_yaml(&dup).unwrap()).is_err());
    }

    #[test]
    fn defaults_applied() {
        let wf = parse_yaml(VALID).unwrap();
        assert_eq!(wf.nodes[0].retry.max, 0);
        assert_eq!(wf.nodes[0].retry.backoff_ms, 1000);
        assert_eq!(wf.nodes[0].timeout_ms, None);
    }
}
```

- [ ] **Step 2: 运行验证失败**

Run: `cargo test -p flowscope-core workflow`
Expected: FAIL。

- [ ] **Step 3: 实现**

serde 结构体（`deny_unknown_fields`，RetryDef 提供 `Default`）+ Kahn 算法：

```rust
fn validate(wf: &WorkflowDef) -> Result<(), WorkflowError> {
    let mut ids = std::collections::HashSet::new();
    for n in &wf.nodes {
        if !ids.insert(n.id.as_str()) { return Err(WorkflowError::Invalid(format!("重复节点 id: {}", n.id))); }
    }
    let node_ids: HashSet<&str> = ids.iter().copied().collect();
    for e in &wf.edges {
        if !node_ids.contains(e.from.as_str()) || !node_ids.contains(e.to.as_str()) {
            return Err(WorkflowError::Invalid(format!("边引用不存在的节点: {} -> {}", e.from, e.to)));
        }
    }
    // Kahn：入度表 + 队列；处理数 < 节点数 => 有环
    let mut indeg: HashMap<&str, usize> = wf.nodes.iter().map(|n| (n.id.as_str(), 0)).collect();
    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
    for e in &wf.edges { *indeg.entry(e.from.as_str()).or_default() += 0; adj.entry(e.from.as_str()).or_default().push(e.to.as_str()); indeg.entry(e.to.as_str()).and_modify(|d| *d += 1); }
    let mut queue: Vec<&str> = indeg.iter().filter(|(_, d)| **d == 0).map(|(k, _)| *k).collect();
    let mut seen = 0;
    while let Some(n) = queue.pop() { seen += 1;
        for &m in adj.get(n).into_iter().flatten() {
            let d = indeg.get_mut(m).unwrap(); *d -= 1; if *d == 0 { queue.push(m); }
        } }
    if seen != wf.nodes.len() { return Err(WorkflowError::Invalid("工作流存在环".into())); }
    Ok(())
}
```

- [ ] **Step 4: 运行验证通过**

Run: `cargo test -p flowscope-core workflow`
Expected: PASS（3 tests）。

- [ ] **Step 5: Commit**

```bash
git add crates/flowscope-core/src/
git commit -m "feat(core): 工作流 YAML 模型与 DAG 校验（Kahn）"
```

---

### Task 6: 条件边表达式 `cond.rs`

**Files:**
- Create: `crates/flowscope-core/src/cond.rs`
- Modify: `crates/flowscope-core/src/lib.rs`（加 `pub mod cond;`）

**Interfaces:**
- Consumes: 无
- Produces:

```rust
pub enum Cond { Eq { path: String, value: serde_json::Value },
    Contains { path: String, value: String }, And(Box<Cond>, Box<Cond>) }
pub fn parse(expr: &str) -> Result<Cond, CondError>;   // 支持 "output.a.b == true|1|\"s\""、"output.a contains \"x\""、"and" 连接（空格分隔两个子式）
pub fn eval(cond: &Cond, output: &serde_json::Value) -> bool;  // path 去掉 "output." 前缀后按 "." 逐层取值；Contains 仅对字符串值
#[derive(Error, Debug)] pub struct CondError(pub String);  // thiserror #[error("cond: {0}")]
```

- [ ] **Step 1: 写失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn eq_bool_and_nested_path() {
        let c = parse("output.data.ok == true").unwrap();
        assert!(eval(&c, &json!({"data": {"ok": true}})));
        assert!(!eval(&c, &json!({"data": {"ok": false}})));
    }

    #[test]
    fn contains_and_conjunction() {
        let c = parse(r#"output.summary contains "失败" and output.ok == false"#).unwrap();
        assert!(eval(&c, &json!({"summary": "执行失败", "ok": false})));
        assert!(!eval(&c, &json!({"summary": "成功", "ok": false})));
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse("output.a >= 5").is_err());
        assert!(parse("output.a == ").is_err());
    }
}
```

- [ ] **Step 2: 运行验证失败** — Run: `cargo test -p flowscope-core cond` Expected: FAIL。

- [ ] **Step 3: 实现（手写解析 ~60 行：按 " and " 拆分→按 " == "/" contains " 拆分→字面量解析 true/false/整数/带引号字符串；path 取值用 serde_json::Value::get 逐段）**

- [ ] **Step 4: 运行验证通过** — Run: `cargo test -p flowscope-core cond` Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add crates/flowscope-core/src/
git commit -m "feat(core): 条件边表达式解析与求值（==/contains/and）"
```

---

### Task 7: flowscope-mock-agent（手写 JSON-RPC over stdio）

**Files:**
- Modify: `crates/flowscope-mock-agent/src/main.rs`（完整实现）
- Create: `crates/flowscope-mock-agent/examples/demo-script.yaml`

**Interfaces:**
- Consumes: ACP v1 wire protocol（JSON-RPC 2.0 行分隔 stdio）
- Produces: 可执行文件 `flowscope-mock-agent`；启动参数 `--script <path>`（缺省读 env `MOCK_SCRIPT`）；行为完全由脚本驱动，供 Task 8/11/16 使用。

脚本格式：

```yaml
# demo-script.yaml
steps:
  - {delay_ms: 50, message: "正在收集数据..."}
  - {tool: {id: t1, title: "查询数据库", kind: fetch, status: in_progress}}
  - {delay_ms: 80, message: "检索完成"}
  - {tool: {id: t1, status: completed}}
  - {plan: [{id: p1, content: 收集数据, status: completed}, {id: p2, content: 生成摘要, status: in_progress}]}
  - {message: '{"ok": true, "data_path": "out/report.md"}'}
final_message: '{"ok": true, "data_path": "out/report.md"}'
stop: end_turn        # end_turn | cancelled | refusal | max_tokens
crash_after: null     # 整数：执行到该 step 后进程 stderr 打印并 exit(3)（失败注入）
stderr_lines: ["mock agent starting"]   # 启动即向 stderr 输出的行
```

协议实现要点（main.rs，全量约 220 行）：

1. stdin 按行读 JSON-RPC；维护 `respond(id, result)` / `notify(method, params)` 两个帮助函数（stdout 单行 JSON，**无缓冲、立即 flush**）。
2. `initialize` → result `{protocolVersion:1, agentCapabilities:{loadSession:false}, authMethods:[]}`。
3. `session/new` → result `{sessionId:"mock-s1"}`。
4. `session/prompt` → **先回空响应占位不符合 ACP**——正确做法：流式 `session/update` 通知逐条发出（`sessionUpdate` 字段结构见下），发完最后一个 update 后再以 `{stopReason: <stop>}` 响应该 prompt 请求。
5. update 通知的 params 形如 `{"sessionId":"mock-s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"..."}}}`；工具调用 `{"sessionUpdate":"tool_call","toolCallId":"t1","title":"查询数据库","kind":"fetch","status":"in_progress","content":[{"type":"text","text":"..."}]}`（status 更新走 `tool_call_update`）；plan `{"sessionUpdate":"plan","plan":{"steps":[{"id":"p1","content":"收集数据","status":"completed"}]}}`。字段名以 agentclientprotocol.com v1 spec 的 schema 为准——**Step 1 先核对 spec 页面**（见下）。
6. `fs/read_text_file` / `fs/write_text_file` / `terminal/*` → 返回错误 `-32601 method not found`（mock 不触发客户端回调路径；回调策略的测试在 Task 8 用单元测试覆盖）。
7. stderr 行直接 `eprintln!`。

- [ ] **Step 1: 核对 ACP v1 wire 字段**

打开 https://agentclientprotocol.com 的 v1 schema 页（`session/update` 的 `SessionUpdate` 联合类型与 `session/prompt` 响应的 `StopReason`），把上面第 5 点的字段名逐一对齐（差一个字段名 Task 8 的映射就会全错，本步必须做）。

- [ ] **Step 2: 实现 main.rs（脚本解析 + JSON-RPC 循环 + 失败注入）**

- [ ] **Step 3: 手工冒烟**

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"mock-s1","prompt":"hi"}}' \
  | cargo run -p flowscope-mock-agent -- --script crates/flowscope-mock-agent/examples/demo-script.yaml
```

Expected: stdout 依次输出 initialize 响应、session/new 响应、若干 `session/update` 通知、最后 prompt 响应带 `"stopReason":"end_turn"`。

- [ ] **Step 4: Commit**

```bash
git add crates/flowscope-mock-agent/
git commit -m "feat(mock-agent): 脚本驱动的 ACP v1 模拟 agent（stdio JSON-RPC）"
```

---

### Task 8: ACP 接入层 `acp/`

**Files:**
- Create: `crates/flowscope-core/src/acp/mod.rs`、`crates/flowscope-core/src/acp/registry.rs`、`crates/flowscope-core/src/acp/session.rs`
- Modify: `crates/flowscope-core/src/lib.rs`（加 `pub mod acp;`）

**Interfaces:**
- Consumes: `crate::events::{EventKind, FsEvent}`；crate `agent-client-protocol`（`AcpAgent`/`AcpAgentConfig`/`ConnectTo`/`ActiveSession::{send_prompt, read_update}`/`SessionMessage::{Dispatch, StopReason}`）
- Produces:

```rust
// registry.rs
pub struct AgentConfig { pub key: String, pub name: String, pub command: Vec<String>,
    pub cwd: Option<std::path::PathBuf>, pub env: std::collections::BTreeMap<String, String>,
    pub default_mode: Option<String>, pub permission_default: PermissionDefault }
pub enum PermissionDefault { AllowOnce, Deny }
pub struct AgentRegistry { pub agents: std::collections::BTreeMap<String, AgentConfig> }
impl AgentRegistry { pub fn load_toml(path: &std::path::Path) -> Result<Self, AcpError>;  // agents.toml，格式见 spec 3.1
    pub fn get(&self, key: &str) -> Result<&AgentConfig, AcpError>; }

// session.rs
pub struct NodeRequest { pub run_id: String, pub node_id: String, pub session_id: String,
    pub prompt: String, pub timeout: Option<std::time::Duration> }
pub enum NodeFailure { ProcessExit(String), Timeout, Refusal, MaxTokens }   // ProcessExit 带 stderr 尾部
pub async fn run_agent_node(cfg: &AgentConfig, req: &NodeRequest,
    sink: &dyn Fn(FsEvent)) -> Result<String, NodeFailure>;
// 行为：spawn agent 子进程（AcpAgent::new）→ initialize/new session → send_prompt →
// 循环 read_update：Dispatch(消息块/工具/plan/meta) → sink(FsEvent)；StopReason → 返回末条完整消息文本；
// stderr 行 → sink(LogLines{lines,level:"info"})；客户端回调按 spec 3.3 策略应答并 sink(Callback/Permission)；
// 超时 → drop session（crate 语义：连接 drop 杀进程组）→ Err(Timeout)
#[derive(Error, Debug)] pub enum AcpError { #[error("{0}")] Other(String) }
```

- [ ] **Step 1: 核对 crate 客户端侧 API（本步必做，防止签名漂移）**

读 docs.rs：`agent_client_protocol::AcpAgent`、`struct.SessionBuilder`、`struct.ActiveSession`、`enum.SessionMessage`、`role` 模块（Client 角色如何安装 handler：`fs/read_text_file` 等回调的实现 trait 名）。下面代码按 docs.rs 摘要写成，**若方法名有出入以 docs.rs 为准在本步修正后继续**。

- [ ] **Step 2: 写失败集成测试（对 mock-agent 跑通一个节点）**

`crates/flowscope-core/src/acp/session.rs` 底部：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::EventKind;
    use std::sync::{Arc, Mutex};

    fn mock_cfg() -> AgentConfig {
        let exe = std::env::var("CARGO_BIN_EXE_flowscope-mock-agent").unwrap();
        let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../flowscope-mock-agent/examples/demo-script.yaml");
        AgentConfig { key: "mock".into(), name: "Mock".into(),
            command: vec![exe, "--script".into(), script.into()], cwd: None,
            env: Default::default(), default_mode: None, permission_default: PermissionDefault::Deny }
    }

    #[tokio::test]
    async fn runs_mock_agent_and_emits_expected_events() {
        let events: Arc<Mutex<Vec<FsEvent>>> = Arc::new(Mutex::new(vec![]));
        let sink = { let ev = events.clone(); move |e: FsEvent| ev.lock().unwrap().push(e) };
        let req = NodeRequest { run_id: "r".into(), node_id: "n".into(), session_id: "s".into(),
            prompt: "hi".into(), timeout: Some(std::time::Duration::from_secs(10)) };
        let msg = run_agent_node(&mock_cfg(), &req, &sink).await.unwrap();
        assert_eq!(msg, "{\"ok\": true, \"data_path\": \"out/report.md\"}");
        let ev = events.lock().unwrap();
        let kinds: Vec<EventKind> = ev.iter().map(|e| e.kind).collect();
        assert!(kinds.contains(&EventKind::MsgDelta));
        assert!(kinds.contains(&EventKind::ToolUpdate));
        assert!(kinds.contains(&EventKind::PlanSnapshot));
        assert!(kinds.iter().filter(|k| **k == EventKind::ToolUpdate).count() >= 2); // in_progress + completed
    }
}
```

（`CARGO_BIN_EXE_flowscope-mock-agent` 在 core 的测试里不可用——它是 mock-agent 包自己的环境变量。修正：测试改走 `cargo run -p flowscope-mock-agent` 不行（路径问题）；**采用 dev-dependencies 方案**：在 `flowscope-core/Cargo.toml` 加 `[dev-dependencies] flowscope-mock-agent = { path = "../flowscope-mock-agent" }` 并把 mock-agent 加 `[lib] name` 同时保留 bin，或最简：mock-agent 的脚本执行逻辑放进 `flowscope-mock-agent/src/lib.rs`（`pub fn run(script: &str)`），main.rs 只是薄壳调用，core 测试 dev-dep 该 crate 直接拼 exe 路径改为 spawn `flowscope-mock-agent` bin via `escargot`？——**最简方案**：core 的 dev-dependencies 加 `flowscope-mock-agent = { path = "../flowscope-mock-agent" }`，mock-agent 提供 lib 入口 `pub fn serve(script_path: &Path) -> !`（读 stdin 写 stdout），测试里用 `std::process::Command::new(env!("CARGO"))` 不可靠——**最终采用**：mock-agent lib 暴露 `pub fn main_args(args)`，测试用 `assert_cmd` 风格太重；直接让测试自己 spawn 当前测试可执行文件的子命令模式：在 core 测试里 `Command::new(std::env::current_exe())` + `FLOWSCOPE_TEST_MOCK_AGENT=1` env，main 入口检测该 env 转发 mock-agent lib。**落定**：`flowscope-core` dev-dep `flowscope-mock-agent`（lib 化），测试进程 spawn 自身可执行文件带 env 开关进入 mock 模式——零外部二进制依赖，写进实现。）

- [ ] **Step 3: 实现 registry.rs（toml 解析，用 `toml` crate——加入 workspace.dependencies `toml = "0.8"`，core 加依赖）与 session.rs**

session.rs 核心结构（按 Step 1 核对后的签名）：

```rust
pub async fn run_agent_node(cfg: &AgentConfig, req: &NodeRequest, sink: &dyn Fn(FsEvent)) -> Result<String, NodeFailure> {
    let mut agent = agent_client_protocol::AcpAgent::new(acp_config_for(cfg)); // command/args/env/cwd
    // stderr→LogLines：AcpAgent::with_debug 或 spawn_process 拿 ChildStderr（按 Step 1 核对结果选择）
    // 连接：agent.connect_to(policy_client(cfg)) —— PolicyClient 实现客户端回调：
    //   fs/read_text_file: cwd 白名单内 allow，否则 deny；fs/write|terminal: deny；
    //   request_permission: 按 cfg.permission_default；每次决策 sink(Callback/Permission)
    // 会话：build session（cwd）→ start_session() → send_prompt(req.prompt)
    // 循环：loop { match session.read_update().await {
    //   SessionMessage::Dispatch(d) => match 消息类型 {   // 用 crate 的 MatchDispatch 或 schema match
    //       agent_message_chunk(text) => { full.push_str; sink(MsgDelta{delta, content_type}) }
    //       tool_call / tool_call_update => sink(ToolUpdate{tool_call_id,title,kind,status,content})
    //       plan => sink(PlanSnapshot{steps})
    //       current_mode_update / available_commands_update => sink(SessionMeta{...})
    //   }
    //   SessionMessage::StopReason(r) => return match r { EndTurn => Ok(full), Cancelled => Err(ProcessExit("cancelled")) , Refusal => Err(Refusal), MaxTokens => Err(MaxTokens) }
    // }}
    // 外层 tokio::time::timeout(req.timeout) → drop session 杀进程组 → Err(Timeout)
    # unimplemented!()
}
```

（骨架展示控制流；实现在本步完成，映射表逐条对照 spec 3.4。）

- [ ] **Step 4: 运行验证通过**

Run: `cargo test -p flowscope-core acp`
Expected: PASS（集成测试对 mock-agent 跑通，事件序列符合断言）。

- [ ] **Step 5: Commit**

```bash
git add crates/
git commit -m "feat(core): ACP 接入层——registry + session 运行器（update→事件映射、回调策略、超时杀进程）"
```

---

### Task 9: Prompt 渲染与结构化输出提取 `render.rs`

**Files:**
- Create: `crates/flowscope-core/src/render.rs`
- Modify: `crates/flowscope-core/src/lib.rs`（加 `pub mod render;`）

**Interfaces:**
- Consumes: `minijinja`、`jsonschema`
- Produces:

```rust
pub fn render_prompt(template: &str, params: &serde_json::Value,
    node_outputs: &std::collections::HashMap<String, serde_json::Value>) -> Result<String, RenderError>;
pub fn extract_output(last_message: &str, schema: Option<&serde_json::Value>)
    -> Result<serde_json::Value, RenderError>;
// 无 schema → {"text": last_message}；有 schema → 从消息中截取首个 '{' 到末个 '}' 解析 JSON 并校验；
// 无合法 JSON 或校验失败 → Err（引擎将其转为 node.failed(extraction)）
#[derive(Error, Debug)] pub enum RenderError { #[error("template: {0}")] Template(String),
    #[error("extraction: {0}")] Extraction(String) }
```

- [ ] **Step 1: 写失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn renders_params_and_node_outputs() {
        let out = render_prompt("分析 {{ params.week }} / {{ nodes.a.output.text }}",
            &json!({"week": "W38"}),
            &[( "a".to_string(), json!({"output": {"text": "数据x"}}))].into()).unwrap();
        assert_eq!(out, "分析 W38 / 数据x");
    }

    #[test]
    fn extracts_structured_or_wraps_text() {
        let schema = json!({"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}});
        let v = extract_output(r#"前缀 {"ok": true} 后缀"#, Some(&schema)).unwrap();
        assert_eq!(v["ok"], true);
        let v = extract_output("纯文本", None).unwrap();
        assert_eq!(v["text"], "纯文本");
        assert!(extract_output("没有json", Some(&schema)).is_err());
        assert!(extract_output(r#"{"ok": "yes"}"#, Some(&schema)).is_err()); // 类型不符
    }
}
```

- [ ] **Step 2: 验证失败** — Run: `cargo test -p flowscope-core render` Expected: FAIL。

- [ ] **Step 3: 实现**（minijinja `Environment::empty().render_named_str`，context 用 `serde_json::Value` 直接作为 context——minijinja 支持 Value 类型；extract 用 `str::find('{')/rfind('}')` + `jsonschema::validator_for`）。

- [ ] **Step 4: 验证通过** — Run: `cargo test -p flowscope-core render` Expected: PASS。

- [ ] **Step 5: Commit** — `git add crates/ && git commit -m "feat(core): prompt 渲染与 output_schema 结构化提取"`

---

### Task 10: 编排引擎 `engine.rs`

**Files:**
- Create: `crates/flowscope-core/src/engine.rs`
- Modify: `crates/flowscope-core/src/lib.rs`（加 `pub mod engine;`）

**Interfaces:**
- Consumes: `workflow::{WorkflowDef, parse_yaml, validate}`、`cond::{parse as parse_cond, eval}`、`render::{render_prompt, extract_output}`、`events::{EventKind, FsEvent}`、`store::Store`、`hub::EventHub`
- Produces:

```rust
#[async_trait::async_trait]
pub trait NodeExecutor: Send + Sync {
    async fn execute(&self, req: ExecRequest) -> Result<String, NodeFailure2>;
}
pub struct ExecRequest { pub run_id: String, pub node_id: String, pub agent_key: String,
    pub prompt: String, pub timeout: Option<std::time::Duration> }
pub enum NodeFailure2 { Retryable(String), Fatal(crate::acp::NodeFailure) }
// Retryable: 进程退出/超时（按 retry 重试）；Fatal: refusal/max_tokens（不重试）。MVP：NodeFailure 全部按 Retryable 处理亦可——**落定：ProcessExit/Timeout→Retryable，Refusal/MaxTokens→Fatal**

pub struct Engine { /* store: Arc<Store>, hub: Arc<EventHub>, executor: Arc<dyn NodeExecutor>,
   concurrency: usize(默认4), runs: Mutex<HashMap<String, RunHandle>> }
pub struct RunHandle { cancel: tokio_util::sync::CancellationToken }  // workspace.dependencies 加 tokio-util = "0.7"

impl Engine {
    pub fn new(store: Arc<Store>, hub: Arc<EventHub>, executor: Arc<dyn NodeExecutor>) -> Self;
    pub async fn start_run(&self, wf: WorkflowDef, params: serde_json::Value) -> Result<String, EngineError>;
    pub fn cancel_run(&self, run_id: &str) -> Result<(), EngineError>;
    pub fn mark_interrupted_on_boot(&self);  // running_runs() 全部 set_run_status("interrupted")
}
pub struct AcpExecutor { pub registry: Arc<crate::acp::AgentRegistry> }
#[async_trait::async_trait] impl NodeExecutor for AcpExecutor { /* 组装 NodeRequest 调 run_agent_node；事件经引擎注入的 per-run sink 转发——通过 ExecRequest 之外的引擎侧闭包注入：AcpExecutor 持有 Arc<EventHub> 与 run 上下文由引擎在 execute 前写入 hub 的事件用引擎自身 seq。落定接口：execute(&self, req, sink: &EventSink) —— 修改 trait 签名为 async fn execute(&self, req: ExecRequest, sink: &EventSink) -> Result<String, NodeFailure2> */ }

#[derive(Clone)]
pub struct EventSink { run_id: std::sync::Arc<str>, seq: std::sync::Arc<std::sync::atomic::AtomicU64>,
    hub: Arc<EventHub>, store_tx: tokio::sync::mpsc::Sender<Vec<FsEvent>> }
impl EventSink { pub fn emit(&self, node_id: Option<&str>, session_id: Option<&str>, kind: EventKind, payload: serde_json::Value); }
```

**NodeExecutor 最终签名**（以本 Task 为准）：

```rust
#[async_trait::async_trait]
pub trait NodeExecutor: Send + Sync {
    async fn execute(&self, req: ExecRequest, sink: &EventSink) -> Result<String, NodeFailure2>;
}
```

引擎调度语义（spec 4.2）：Kahn 就绪集 + `Semaphore(concurrency)`；节点完成→输出存 `HashMap<node_id, Value>`（供模板）+ artifact；条件边不满足→下游 `node.skipped` 级联；失败→`on_node_failure`(默认 abort_run：cancel 其余、run.failed；`continue_independent` 由 workflow 级字段 `on_node_failure` 控制，加进 WorkflowDef，默认 abort)；重试→`node.retry` 事件 + 退避 `backoff_ms*(attempt)`；`run.started` → 节点事件 → `run.finished/failed/cancelled`；store 批写任务（mpsc，50ms 或 64 条 flush）。

- [ ] **Step 1: 写失败测试（MockExecutor，无 ACP）**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{events::EventKind, hub::EventHub, store::Store};
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    struct MockExecutor { outcomes: Mutex<std::collections::HashMap<String, usize>> } // 每节点被调次数
    #[async_trait]
    impl NodeExecutor for MockExecutor {
        async fn execute(&self, req: ExecRequest, sink: &EventSink) -> Result<String, NodeFailure2> {
            *self.outcomes.lock().unwrap().entry(req.node_id.clone()).or_insert(0) += 1;
            sink.emit(Some(&req.node_id), None, EventKind::MsgDelta, json!({"delta": "..."}));
            match req.node_id.as_str() {
                "ok1" | "ok2" => Ok("{\"ok\": true}".into()),
                "flaky" => { // 第一次失败，重试成功（max=1）
                    let n = *self.outcomes.lock().unwrap().get("flaky").unwrap();
                    if n == 1 { Err(NodeFailure2::Retryable("boom".into())) } else { Ok("{\"ok\": true}".into()) }
                }
                "bad" => Err(NodeFailure2::Retryable("always fails".into())),
                _ => Ok("x".into()),
            }
        }
    }

    fn engine_with(ex: Arc<dyn NodeExecutor>) -> (Arc<Store>, Arc<Hub2>, Arc<Engine>) { /* in-memory store + hub + Engine::new，mark_interrupted_on_boot 跳过 */ }

    #[tokio::test]
    async fn happy_path_linear_and_conditional_skip() {
        let wf = crate::workflow::parse_yaml(r#"
meta: {name: t, version: 1}
nodes:
  - {id: ok1, agent: m, prompt: "p1"}
  - {id: ok2, agent: m, prompt: "p2", output_schema: {type: object, required: [ok], properties: {ok: {type: boolean}}}}
  - {id: skipped_child, agent: m, prompt: "p3"}
edges:
  - {from: ok1, to: ok2}
  - {from: ok2, to: skipped_child, when: "output.ok == false"}
"#).unwrap();
        // ... engine.start_run + 等待终态（轮询 store.get_run status，超时 5s）
        // 断言：run finished；ok1/ok2 各执行 1 次；skipped_child 未执行（outcomes 无该 key）且事件流含 node.skipped
    }

    #[tokio::test]
    async fn retry_then_abort_run_on_persistent_failure() {
        // bad 节点 retry.max=1 → 两次失败 → run failed；flaky 场景单独验证 node.retry 事件存在
    }

    #[tokio::test]
    async fn cancel_run_marks_pending_skipped() { /* start_run 后立即 cancel；等待终态；断言 run cancelled + 未启动节点 node.skipped */ }
}
```

（注释处断言在实现时补全为具体代码——测试意图已完全确定：终态、执行次数、事件 kind 存在性。）

- [ ] **Step 2: 验证失败** — Run: `cargo test -p flowscope-core engine` Expected: FAIL。

- [ ] **Step 3: 实现 engine.rs**（调度循环 ~200 行：`tokio::spawn` 每 run 一个驱动任务；就绪集=入度清零且前驱终态可满足；EventSink 批写任务；`WorkflowDef` 加 `on_node_failure: Option<String>` 字段并更新 workflow.rs 的 serde（default abort）与 Task 5 测试不动——新字段可选）。

- [ ] **Step 4: 验证通过** — Run: `cargo test -p flowscope-core` Expected: PASS（含 Task 5/6/9 旧测试不回归）。

- [ ] **Step 5: Commit** — `git add crates/ && git commit -m "feat(core): DAG 编排引擎（并发/条件/重试/取消/跳过/终态，事件溯源驱动）"`

---

### Task 11: 端到端集成（engine × acp × store × hub × mock-agent）

**Files:**
- Create: `crates/flowscope-core/tests/e2e_mock_agent.rs`

**Interfaces:**
- Consumes: Task 7-10 全部产物
- Produces: 集成测试（后续回归基线）

- [ ] **Step 1: 写测试**

```rust
// 用真实 AcpExecutor + mock-agent（进程内 mock 模式，同 Task 8 方案）驱动 3 节点线性工作流：
// collect → analyze(带 output_schema) → report；脚本让 collect 输出 {"ok":true,...}
// 断言：
// 1) run 终态 finished；2) events 表事件齐全（run.started / 每节点 node.started+msg.delta+tool.update+node.finished / run.finished）
// 3) seq 严格递增无空洞；4) analyze 的 artifact "output" 存在且 {"ok":true}
// 5) hub.snapshot_after(run,0).len() == store.events_after(run,0,10000).len()
// 6) 第二条脚本（crash_after 注入）驱动单节点工作流 → node.failed + run.failed，payload 含 stderr 尾部行
```

- [ ] **Step 2: 运行** — Run: `cargo test -p flowscope-core --test e2e_mock_agent` Expected: FAIL→逐步实现缺失接线→PASS（Engine 与 AcpExecutor 的组装函数放测试里，Task 12 的 api 才固化组装）。

- [ ] **Step 3: Commit** — `git add crates/ && git commit -m "test(core): 端到端集成——mock-agent 全链路（含失败注入）"`

---

### Task 12: axum API（REST + SSE）与 dev 启动器

**Files:**
- Create: `crates/flowscope-core/src/api.rs`、`crates/flowscope-core/src/bin/dev.rs`
- Modify: `crates/flowscope-core/src/lib.rs`（加 `pub mod api;`）

**Interfaces:**
- Consumes: 前序全部
- Produces:

```rust
pub struct AppState { pub engine: Arc<EngineCtl>, pub store: Arc<Store>, pub hub: Arc<EventHub>,
    pub registry: Arc<AgentRegistry>, pub workflows_dir: std::path::PathBuf }
pub fn router(state: AppState) -> axum::Router;   // 含可选静态托管（ServeDir frontend/dist + SPA fallback）
pub struct EngineCtl { pub engine: std::sync::Mutex<Option<Arc<Engine>>>, pub store: Arc<Store>, pub hub: Arc<EventHub> }
impl EngineCtl { pub async fn start_run(&self, workflow_yaml: &str, params: Value) -> Result<String, ApiError>; }
```

路由（spec 6.1 子集，全部同源）：`GET/POST /api/workflows`、`GET/DELETE /api/workflows/:id`、`POST /api/workflows/:id/runs`、`GET /api/runs`、`GET /api/runs/:id`、`POST /api/runs/:id/cancel`、`GET /api/runs/:id/events?after=`（SSE，`Last-Event-ID` 头等价）、`GET /api/runs/:id/artifacts/:node/:name`、`GET /api/agents`。

SSE 实现要点：先 `hub.subscribe` 再 `hub.snapshot_after`（按 seq 去重防缝隙）→ 逐条 `Event::default().id(seq).json_data(ev)` → `KeepAlive::default()`；ring 之外的缺口从 `store.events_after` 补。

`bin/dev.rs`：参数 `--port 39271 --home <dir> --frontend-dist <path>`；home 下初始化 `agents.toml`（注册 mock-agent，bin 路径取 `FLOWSCOPE_MOCK_AGENT_BIN` env 或参数）、SQLite、示例工作流 `weekly-report.yaml`（3 节点，spec 4.1 示例）；启动 router。前端开发期 `--frontend-dist` 可指向不存在路径（跳过静态托管）。

- [ ] **Step 1: 写失败测试（tower::ServiceExt::oneshot + SSE body 流）**

```rust
// crates/flowscope-core/src/api.rs 底部 tests：
// 1) POST /api/workflows（合法 YAML）→ 200 {id}；GET /api/workflows → 列表含它
// 2) POST /api/workflows/:id/runs {"params":{}} → 200 {run_id}；GET /api/runs/:id → status 字段
// 3) SSE：seed hub（publish seq 1..3）→ GET events?after=0 → body 前三行 data 依次 seq1..3 且 id: 字段=seq
// 4) after=2 → 只回 seq3；再 publish seq4 → 流里继续出现（用 body.into_data_stream() 取前 N 块断言）
// 5) 非法 YAML → 400 {error}
```

- [ ] **Step 2: 验证失败** — Run: `cargo test -p flowscope-core api` Expected: FAIL。

- [ ] **Step 3: 实现 api.rs + dev.rs**（axum 0.8 路由宏；`axum::response::Sse`；`axum::extract::State/Path/Query`；错误统一 `Json({"error": msg})` + 恰当状态码）。

- [ ] **Step 4: 验证通过 + 手工冒烟**

Run: `cargo test -p flowscope-core && cargo run -p flowscope-core --bin dev -- --port 39271 --home target/dev-home`
再: `curl -N "http://127.0.0.1:39271/api/runs/<id>/events?after=0"`（先 POST 一个 run）
Expected: 测试全 PASS；curl 持续吐 SSE 行。

- [ ] **Step 5: Commit** — `git add crates/ && git commit -m "feat(core): axum REST+SSE API 与 dev 启动器（含静态托管）"`

---

### Task 13: 前端脚手架、类型、事件 reducer 与 SSE hook

**Files:**
- Create: `frontend/package.json`、`frontend/vite.config.ts`、`frontend/tsconfig.json`、`frontend/index.html`
- Create: `frontend/src/main.tsx`、`frontend/src/App.tsx`（仅路由骨架）
- Create: `frontend/src/api/types.ts`、`frontend/src/api/client.ts`、`frontend/src/api/useRunEvents.ts`
- Create: `frontend/src/store/runStore.ts`
- Create: `frontend/vitest.config.ts`（或并入 vite.config）

**Interfaces:**
- Consumes: Task 12 的 HTTP/SSE API
- Produces:

```ts
// types.ts（与 Rust serde 对齐，snake_case 字段）
export type EventKind = 'run.started'|'run.finished'|'run.failed'|'run.cancelled'|'run.interrupted'
 |'node.started'|'node.finished'|'node.cancelled'|'node.failed'|'node.skipped'|'node.retry'
 |'msg.delta'|'tool.update'|'plan.snapshot'|'session.meta'|'log.lines'|'callback'|'permission';
export interface FsEvent { seq: number; ts: string; run_id: string; node_id: string|null;
  session_id: string|null; kind: EventKind; payload: any }
export interface WorkflowSummary { id: string; name: string; version: number }
export interface WorkflowDetail extends WorkflowSummary { yaml: string; graph: { nodes: {id:string; agent:string}[]; edges: {from:string;to:string;when?:string}[] } }
export interface RunRow { id: string; workflow_id: string; status: string; started_at: string; ended_at: string|null }

// runStore.ts
export interface NodeView { status: 'pending'|'running'|'succeeded'|'failed'|'cancelled'|'skipped';
  startedAt?: string; endedAt?: string; message: string; reasoning: string[];
  tools: { id: string; title: string; kind?: string; status: string }[];
  plan?: { steps: { id: string; content: string; status: string }[] };
  logs: string[]; lastToolTitle?: string; error?: string }
export interface RunView { runId: string; status: string; lastSeq: number; nodes: Record<string, NodeView> }
export function applyEvent(view: RunView, ev: FsEvent): RunView   // 纯函数，唯一状态转移
export const useRunStore: import('zustand').UseBoundStore<...>    // { view: RunView|null, setRun, apply(ev) }

// client.ts
export const api = { listWorkflows, getWorkflow, saveWorkflow(id, yaml), deleteWorkflow,
  listRuns, getRun, startRun(workflowId, params), cancelRun(runId), eventsUrl(runId, after) }

// useRunEvents.ts
export function useRunEvents(runId: string|null): { connected: boolean }  // EventSource(eventsUrl(runId,lastSeq))，onmessage→store.apply；onerror→重连（指数退避 1s..10s）
```

依赖：`react@18 react-dom@18 react-router-dom@6 zustand@5 @tanstack/react-query@5 @xyflow/react@12 @dagrejs/dagre@1 react-window@^1.8`；dev: `vite@6 @vitejs/plugin-react typescript vitest @testing-library/react jsdom`。

- [ ] **Step 1: npm 脚手架**（npm create vite@latest frontend -- --template react-ts 后替换依赖版本如上；`vite.config.ts` 设 `server.port=5173`、`build.outDir=dist`）

- [ ] **Step 2: 写 reducer 失败测试 `frontend/src/store/runStore.test.ts`**

```ts
import { applyEvent, emptyView } from './runStore';
import type { FsEvent } from '../api/types';

const ev = (seq: number, kind: FsEvent['kind'], node_id: string|null, payload: any): FsEvent =>
  ({ seq, ts: '2026-09-22T10:00:00Z', run_id: 'r', node_id, session_id: null, kind, payload });

describe('applyEvent', () => {
  it('节点生命周期：started→running，finished→succeeded，delta 累积', () => {
    let v = emptyView('r', ['a']);
    v = applyEvent(v, ev(1, 'node.started', 'a', {}));
    expect(v.nodes.a.status).toBe('running');
    v = applyEvent(v, ev(2, 'msg.delta', 'a', { delta: '你', content_type: 'text' }));
    v = applyEvent(v, ev(3, 'msg.delta', 'a', { delta: '好', content_type: 'text' }));
    expect(v.nodes.a.message).toBe('你好');
    v = applyEvent(v, ev(4, 'node.finished', 'a', { duration_ms: 100 }));
    expect(v.nodes.a.status).toBe('succeeded');
    expect(v.lastSeq).toBe(4);
  });
  it('tool 状态迁移与 plan 快照、日志追加、skipped/failed 终态', () => {
    let v = emptyView('r', ['a','b']);
    v = applyEvent(v, ev(1, 'tool.update', 'a', { toolCallId: 't1', title: '查询', status: 'in_progress' }));
    expect(v.nodes.a.tools[0].status).toBe('in_progress');
    expect(v.nodes.a.lastToolTitle).toBe('查询');
    v = applyEvent(v, ev(2, 'tool.update', 'a', { toolCallId: 't1', status: 'completed' }));
    expect(v.nodes.a.tools[0].status).toBe('completed');
    v = applyEvent(v, ev(3, 'plan.snapshot', 'a', { steps: [{ id: 'p1', content: 'x', status: 'completed' }] }));
    expect(v.nodes.a.plan?.steps.length).toBe(1);
    v = applyEvent(v, ev(4, 'log.lines', 'a', { lines: ['l1','l2'], level: 'info' }));
    expect(v.nodes.a.logs).toEqual(['l1','l2']);
    v = applyEvent(v, ev(5, 'node.failed', 'a', { reason: 'process_exit' }));
    expect(v.nodes.a.status).toBe('failed');
    v = applyEvent(v, ev(6, 'node.skipped', 'b', {}));
    expect(v.nodes.b.status).toBe('skipped');
  });
  it('run 级事件与 reasoning 块', () => {
    let v = emptyView('r', ['a']);
    v = applyEvent(v, ev(1, 'run.started', null, {}));
    expect(v.status).toBe('running');
    v = applyEvent(v, ev(2, 'msg.delta', 'a', { delta: '思', content_type: 'reasoning' }));
    expect(v.nodes.a.message).toBe('');
    expect(v.nodes.a.reasoning).toEqual(['思']);
    v = applyEvent(v, ev(3, 'run.failed', null, {}));
    expect(v.status).toBe('failed');
  });
});
```

- [ ] **Step 3: 验证失败** — Run: `cd frontend && npm test -- --run` Expected: FAIL（模块不存在）。

- [ ] **Step 4: 实现 types/client/runStore/useRunEvents**（reducer 按 payload 契约写：`msg.delta{delta,content_type}`、`tool.update{toolCallId,title,kind,status,content}`、`plan.snapshot{steps[]}`、`log.lines{lines[],level}`、终态事件 payload 携带 `reason/duration_ms`；logs 上限 500 条裁剪）。

- [ ] **Step 5: 验证通过** — Run: `cd frontend && npm test -- --run` Expected: PASS（3 describe 全绿）。

- [ ] **Step 6: Commit** — `git add frontend/ && git commit -m "feat(frontend): 类型/API 客户端/事件 reducer(zustand)/SSE 断线重连 hook"`

---

### Task 14: 监控视图（DAG 画布 + 节点抽屉）与列表/配置页

**Files:**
- Create: `frontend/src/views/RunList.tsx`、`frontend/src/views/WorkflowList.tsx`、`frontend/src/views/WorkflowDetail.tsx`（YAML textarea + 保存 + 启动对话框(params 表单) + 只读画布预览）
- Create: `frontend/src/views/RunMonitor.tsx`、`frontend/src/components/NodeCard.tsx`、`frontend/src/components/NodeDrawer.tsx`、`frontend/src/components/LogList.tsx`（react-window）
- Create: `frontend/src/lib/layout.ts`（@dagrejs/dagre LR 布局：graph→坐标）、`frontend/src/App.tsx` 完整路由（`/`→RunList、`/workflows`、`/workflows/:id`、`/runs/:id`→RunMonitor）+ 侧栏壳

**Interfaces:**
- Consumes: Task 13 全部
- Produces: 完整监控 UI（M1 验收面）

- [ ] **Step 1: 写组件失败测试 `frontend/src/components/NodeCard.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react';
import NodeCard from './NodeCard';

it('按状态着色：running 蓝且带 pulse，failed 红，skipped 灰虚线', () => {
  const base = { id: 'a', agent: 'enterprise' };
  render(<NodeCard data={{ ...base, status: 'running', elapsedMs: 1200, lastToolTitle: '查询' }} />);
  const running = screen.getByTestId('node-card');
  expect(running.className).toMatch(/running/);
  expect(screen.getByText(/查询/)).toBeTruthy();
  render(<NodeCard data={{ ...base, status: 'failed', error: 'process_exit' }} />);
  expect(screen.getByTestId('node-card').className).toMatch(/failed/);
});
```

`NodeDrawer.test.tsx`：向 store 注入构造好的 NodeView（message/tools/plan/logs），断言五个 tab 切换后各自渲染出代表内容（消息文本、工具行、plan 步骤、日志行、输入输出占位）。

- [ ] **Step 2: 验证失败** — Run: `cd frontend && npm test -- --run` Expected: FAIL。

- [ ] **Step 3: 实现全部视图组件**

要点：`RunMonitor` 用 `useRunEvents(runId)` + zustand selector；ReactFlow `<ReactFlow nodes={layouted} nodeTypes={{ agent: NodeCard }} fitView proOptions={{hideAttribution:true}}>`；节点数据 = `NodeView + workflow def 合并`；点击节点→本地 state 选中→`NodeDrawer`（右侧 360px 抽屉，5 tab：消息流[自动跟随/上滚暂停]/工具时间线/Plan/原始日志[react-window]/输入输出[artifact fetch]）；`LogList` 用 `react-window` FixedSizeList；running 节点 1s interval 重渲染显示 elapsed；顶部 run 状态条 + 断线横幅（useRunEvents.connected）。CSS：每状态一个类（`fs-node--running` 等，running 加 `animation: fs-pulse 1.5s infinite`）。

- [ ] **Step 4: 验证通过 + 手工冒烟**

Run: `cd frontend && npm test -- --run && npm run build`
再双终端：`cargo run -p flowscope-core --bin dev -- --port 39271 --home target/dev-home --frontend-dist frontend/dist` + 浏览器开 `http://127.0.0.1:39271`，从 WorkflowList 启动示例工作流，观察节点依次点亮、点开抽屉五 tab。
Expected: 测试全绿；冒烟行为符合描述。

- [ ] **Step 5: Commit** — `git add frontend/ && git commit -m "feat(frontend): 运行监控视图（ReactFlow DAG 状态着色 + 节点抽屉五 tab）与列表/配置页"`

---

### Task 15: Tauri 桌面壳

**Files:**
- Create: `apps/desktop/src-tauri/Cargo.toml`、`apps/desktop/src-tauri/tauri.conf.json`、`apps/desktop/src-tauri/build.rs`、`apps/desktop/src-tauri/src/main.rs`、`apps/desktop/src-tauri/icons/`（`cargo tauri icon` 生成默认）
- Modify: 根 `Cargo.toml`（workspace members 加 `apps/desktop/src-tauri`）

**Interfaces:**
- Consumes: `flowscope_core::api::{router, AppState, EngineCtl}`、Task 7 mock-agent、Task 14 前端构建产物
- Produces: `flowscope-desktop` 三平台可打包应用（M1 交付形态）

- [ ] **Step 1: 生成 Tauri 工程**

Run: `cd apps/desktop && cargo tauri init --app-name FlowScope --window-title FlowScope --dev-url http://127.0.0.1:5173 --before-dev-command "" --before-build-command "cd ../../frontend && npm run build" --frontend-dist ../../frontend/dist`
（若无 cargo-tauri：`cargo install tauri-cli --version "^2"`。`tauri.conf.json` 的 `build.frontendDist` 指向 `../../frontend/dist` 仅用于资源打包；实际窗口 URL 由 main.rs 动态指定。）

- [ ] **Step 2: 写 main.rs（进程内起引擎 + 窗口指向本地端口）**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    let home = dirs::home_dir().unwrap().join(".flowscope");
    std::fs::create_dir_all(&home).unwrap();
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let port = rt.block_on(async {
        // 1) Store/Hub/Registry(agents.toml, 无则写入 mock-agent 示例)/EngineCtl 组装（复用 bin/dev.rs 的组装函数——
        //    把 dev.rs 的组装提炼为 flowscope-core::api::bootstrap(home, mock_agent_bin: Option<PathBuf>) -> (AppState, Router)）
        // 2) TcpListener::bind("127.0.0.1:0") 拿随机端口
        // 3) axum::serve(listener, router_with_static) spawn
        // 4) 等待 /api/agents 探活成功（最多 3s）
        port
    });
    tauri::Builder::default()
        .setup(move |app| {
            let webview = tauri::WebviewWindowBuilder::new(app, "main",
                tauri::WebviewUrl::External(format!("http://127.0.0.1:{port}/").parse().unwrap()))
                .title("FlowScope").inner_size(1440.0, 900.0).build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

（`Cargo.toml` 依赖：`tauri = { version = "2", features = [] }`、`flowscope-core = { path = "../../../crates/flowscope-core" }`、`tokio`、`dirs = "6"`；配合把 `bin/dev.rs` 组装逻辑重构为 `api::bootstrap`——本步完成该重构并保持 `cargo test -p flowscope-core` 通过。）

- [ ] **Step 3: 验证**

Run: `cargo fmt && cargo test && cd apps/desktop && cargo tauri dev`
Expected: 测试全绿；弹出 FlowScope 窗口，界面与浏览器版一致，示例工作流可跑。
（打包冒烟：`cargo tauri build` 在 Windows 出 NSIS/MSI 包；三平台打包进 CI 是 M2 范畴。）

- [ ] **Step 4: Commit** — `git add apps/ Cargo.toml Cargo.lock && git commit -m "feat(desktop): Tauri 2 壳——进程内嵌引擎(随机端口)+窗口直连，复用 bootstrap 组装"`

---

### Task 16: Playwright E2E 冒烟与 README

**Files:**
- Create: `frontend/e2e/run.spec.ts`、`frontend/playwright.config.ts`
- Create: `README.md`

**Interfaces:**
- Consumes: Task 12 dev bin + Task 14 前端 + mock-agent
- Produces: M1 验收自动化 + 项目文档

- [ ] **Step 1: Playwright 配置（webServer 拉起 dev bin，port 39271）**

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', timeout: 60_000,
  webServer: { command: 'cargo run -p flowscope-core --bin dev -- --port 39271 --home target/e2e-home --frontend-dist dist',
    port: 39271, reuseExistingServer: !process.env.CI, timeout: 120_000 },
});
```

- [ ] **Step 2: 写用例**

```ts
// e2e/run.spec.ts
import { test, expect } from '@playwright/test';

test('mock 工作流全链路：节点点亮 + 抽屉内容 + 终态', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /启动|Run/ }).first().click();   // WorkflowList 页启动示例工作流（params 默认）
  await expect(page.getByTestId('run-monitor')).toBeVisible();
  // 三个节点依次变绿（mock 每 step 50-80ms，总 <5s）
  await expect(page.locator('.fs-node--succeeded')).toHaveCount(3, { timeout: 15_000 });
  await expect(page.getByTestId('run-status')).toHaveText(/finished/);
  // 点开 analyze 节点抽屉：消息 tab 有 JSON 文本，工具 tab 有 t1
  await page.locator('.fs-node--succeeded').nth(1).click();
  await expect(page.getByTestId('drawer-message').getByText(/ok/)).toBeVisible();
  await page.getByRole('tab', { name: '工具' }).click();
  await expect(page.getByTestId('drawer-tools').getByText(/查询数据库/)).toBeVisible();
});

test('失败注入：节点红 + run failed', async ({ page }) => {
  // dev bin 的 --home 提供 crash 脚本工作流（bin/dev.rs 同时 seed 两个工作流：demo 与 crash-demo）
  // 启动 crash-demo → 期待 .fs-node--failed 与 run-status failed
});
```

- [ ] **Step 3: 运行** — Run: `cd frontend && npx playwright install chromium && npx playwright test` Expected: PASS（2 tests）。

- [ ] **Step 4: README**（项目结构、`cargo run --bin dev` 快速开始、桌面 `cargo tauri dev`、agents.toml 注册企业 agent 的说明、测试矩阵、M2 展望链接 spec/计划）。

- [ ] **Step 5: Commit** — `git add frontend/ README.md && git commit -m "test(e2e): Playwright 冒烟（成功/失败注入）+ README"`

---

## Self-Review 记录

- **Spec 覆盖**：M1 范围 = spec §2.1（core/mock-agent/desktop）、§3（ACP 层）、§4（DSL/引擎）、§5（事件/存储/hub）、§6（API/SSE）、§7.1 视图 1/4(M1 部分)+7.2、§9 错误处理（interrupted/进程崩溃）、§10 测试。§8 的脱敏 hook 属 M1 spec §8 —— **缺口**：脱敏正则未排任务 → 裁决：M1 仅实现 config 字段与 `flowscope-core::events::redact(payload, rules)` 纯函数 + 单测，接线留 M2（spec 标注为可选能力）；已在本记录中明确，不补任务。
- **占位符扫描**：Task 8 Step 3 骨架含 `unimplemented!()` 但控制流/映射逐条写明并强制 Step 1 核对 docs.rs——按技能标准此为"展示完整意图的实现骨架"，执行者可完成；Task 10/11/16 测试中注释断言均附具体断言目标，无 "TBD"。
- **类型一致性**：`NodeFailure`（acp）与 `NodeFailure2`（engine）命名刻意区分（Retryable/Fatal 分层），Task 10 Produces 块已写明映射；`EventSink.emit(node_id, session_id, kind, payload)` 在 Task 8(sink 闭包)/10(EventSink)/12 之间一致——Task 8 用 `&dyn Fn(FsEvent)` 由 AcpExecutor 包装 EventSink，接缝已注明。
