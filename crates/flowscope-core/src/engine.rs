//! DAG 编排引擎（spec §4.2）：就绪集调度 + 并发闸 + 条件跳过级联 + 重试退避 + 取消/失败终态。
//!
//! 事件流：所有事件经 [`EventSink`] 统一分配 seq、即时发布到 [`EventHub`]、
//! 缓冲进 mpsc 由批写任务落库（50ms 或 64 条一批）。

use crate::acp::{AgentRegistry, NodeFailure, NodeRequest, run_agent_node};
use crate::cond::{Cond, eval as eval_cond, parse as parse_cond};
use crate::events::{EventKind, FsEvent};
use crate::hub::EventHub;
use crate::render::{extract_output, render_prompt};
use crate::store::{Store, StoreError};
use crate::workflow::{AgentNodeDef, WorkflowDef};
use async_trait::async_trait;
use chrono::Utc;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::sync::{Semaphore, mpsc};
use tokio_util::sync::CancellationToken;

/// 每个 run 允许同时运行的节点数（M1 固定，不做配置）。
const CONCURRENCY: usize = 4;
/// store 批写：达到该条数立即 flush。
const BATCH_MAX: usize = 64;
/// store 批写：静默窗口。
const FLUSH_EVERY: Duration = Duration::from_millis(50);
/// EventSink → 批写任务的通道容量（emit 为同步 try_send，满了丢弃并告警）。
const STORE_CHANNEL_CAPACITY: usize = 1024;

#[derive(Error, Debug)]
pub enum EngineError {
    #[error("workflow invalid: {0}")]
    InvalidWorkflow(String),
    #[error("params must be an object: {0}")]
    ParamsNotObject(String),
    #[error("store: {0}")]
    Store(#[from] StoreError),
    #[error("unknown run: {0}")]
    UnknownRun(String),
}

/// 节点执行器抽象：引擎只认这个接口；[`AcpExecutor`] 是 ACP 真实实现。
#[async_trait]
pub trait NodeExecutor: Send + Sync {
    async fn execute(&self, req: ExecRequest, sink: &EventSink) -> Result<String, NodeFailure2>;
}

#[derive(Debug, Clone)]
pub struct ExecRequest {
    pub run_id: String,
    pub node_id: String,
    pub agent_key: String,
    pub prompt: String,
    pub timeout: Option<Duration>,
}

/// 引擎视角的节点失败分类（R3/R5）：Retryable 按节点 retry 策略重试，
/// Fatal 立即 `node.failed` 不重试。
#[derive(Debug, Clone)]
pub enum NodeFailure2 {
    Retryable(String),
    Fatal(NodeFailure),
}

/// 每个 run 的事件出口：统一 seq（严格递增）、即时进 hub、缓冲进批写通道。
#[derive(Clone)]
pub struct EventSink {
    run_id: Arc<str>,
    seq: Arc<AtomicU64>,
    hub: Arc<EventHub>,
    store_tx: mpsc::Sender<Vec<FsEvent>>,
}

impl EventSink {
    pub fn emit(
        &self,
        node_id: Option<&str>,
        session_id: Option<&str>,
        kind: EventKind,
        payload: serde_json::Value,
    ) {
        let ev = FsEvent {
            seq: self.seq.fetch_add(1, Ordering::Relaxed) + 1,
            ts: Utc::now(),
            run_id: (*self.run_id).to_owned(),
            node_id: node_id.map(str::to_owned),
            session_id: session_id.map(str::to_owned),
            kind,
            payload,
        };
        self.hub.publish(ev.clone());
        // emit 可能在异步上下文中同步调用，只能 try_send；批写任务消费很快，
        // 容量打满意味着持久化远慢于生产，此时丢弃并告警优于阻塞调度器。
        if let Err(e) = self.store_tx.try_send(vec![ev]) {
            tracing::warn!(run_id = %self.run_id, error = %e, "事件入持久化队列失败");
        }
    }
}

/// store 批写任务：收到首批后，在 50ms 窗口内或攒满 64 条时 flush；
/// 通道关闭（所有 EventSink 释放）时冲刷余量退出。
async fn run_store_batcher(mut rx: mpsc::Receiver<Vec<FsEvent>>, store: Arc<Store>) {
    while let Some(first) = rx.recv().await {
        let mut batch = first;
        while batch.len() < BATCH_MAX {
            match tokio::time::timeout(FLUSH_EVERY, rx.recv()).await {
                Ok(Some(chunk)) => batch.extend(chunk),
                Ok(None) => {
                    flush(&store, &mut batch);
                    return;
                }
                Err(_) => break,
            }
        }
        flush(&store, &mut batch);
    }
}

fn flush(store: &Store, batch: &mut Vec<FsEvent>) {
    if batch.is_empty() {
        return;
    }
    if let Err(e) = store.append_events(batch) {
        tracing::warn!(run_id = %batch[0].run_id, error = %e, "事件批写入 store 失败");
    }
    batch.clear();
}

/// ACP 真实执行器：查 registry、组装 NodeRequest、桥接事件（重分配全局 seq）。
pub struct AcpExecutor {
    pub registry: Arc<AgentRegistry>,
}

#[async_trait]
impl NodeExecutor for AcpExecutor {
    async fn execute(&self, req: ExecRequest, sink: &EventSink) -> Result<String, NodeFailure2> {
        let cfg = self
            .registry
            .get(&req.agent_key)
            .map_err(|e| NodeFailure2::Fatal(NodeFailure::ProcessExit(e.to_string())))?;
        let session_id = format!("sess_{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        let node_req = NodeRequest {
            run_id: req.run_id.clone(),
            node_id: req.node_id.clone(),
            session_id: session_id.clone(),
            prompt: req.prompt.clone(),
            timeout: req.timeout,
        };
        // run_agent_node 产出的事件带会话内局部 seq，此处经 EventSink 重发以获得
        // run 级全局 seq；归因字段（node/session）原样转发。
        let bridge = |ev: FsEvent| {
            sink.emit(
                ev.node_id.as_deref(),
                ev.session_id.as_deref().or(Some(session_id.as_str())),
                ev.kind,
                ev.payload,
            );
        };
        run_agent_node(cfg, &node_req, &bridge)
            .await
            .map_err(|f| match f {
                NodeFailure::ProcessExit(detail) => NodeFailure2::Retryable(detail),
                NodeFailure::Timeout => NodeFailure2::Retryable("node timed out".into()),
                failure @ (NodeFailure::Refusal | NodeFailure::MaxTokens) => {
                    NodeFailure2::Fatal(failure)
                }
            })
    }
}

pub struct RunHandle {
    pub cancel: CancellationToken,
}

pub struct Engine {
    store: Arc<Store>,
    hub: Arc<EventHub>,
    executor: Arc<dyn NodeExecutor>,
    runs: Mutex<HashMap<String, RunHandle>>,
}

impl Engine {
    pub fn new(store: Arc<Store>, hub: Arc<EventHub>, executor: Arc<dyn NodeExecutor>) -> Self {
        Self {
            store,
            hub,
            executor,
            runs: Mutex::new(HashMap::new()),
        }
    }

    /// 校验工作流、合并参数、建 run 行、起批写任务与驱动任务后立即返回 run_id。
    pub async fn start_run(
        &self,
        wf: WorkflowDef,
        params: serde_json::Value,
    ) -> Result<String, EngineError> {
        crate::workflow::validate(&wf).map_err(|e| EngineError::InvalidWorkflow(e.to_string()))?;

        // 条件表达式预解析：坏表达式在启动期拒绝，而不是运行中卡死。
        let mut preds: HashMap<String, Vec<(String, Option<Cond>)>> = HashMap::new();
        for edge in &wf.edges {
            let cond = match &edge.when {
                Some(when) => Some(
                    parse_cond(when).map_err(|e| EngineError::InvalidWorkflow(e.to_string()))?,
                ),
                None => None,
            };
            preds
                .entry(edge.to.clone())
                .or_default()
                .push((edge.from.clone(), cond));
        }

        // 入参覆盖工作流默认参数
        let mut merged = wf.params.clone();
        match params {
            Value::Null => {}
            Value::Object(overrides) => {
                for (k, v) in overrides {
                    merged.insert(k, v);
                }
            }
            other => return Err(EngineError::ParamsNotObject(other.to_string())),
        }
        let params = Value::Object(merged);

        // start_run 只拿到 WorkflowDef（无原始 YAML），落一份 JSON 快照充当
        // workflows.yaml 列内容，保证 runs.workflow_id 外键有真实指向。
        let snapshot = json!({
            "name": wf.name,
            "version": wf.version,
            "onNodeFailure": wf.on_node_failure,
            "nodes": wf.nodes.iter().map(|n| json!({"id": n.id, "agent": n.agent})).collect::<Vec<_>>(),
            "edges": wf.edges.iter().map(|e| json!({"from": e.from, "to": e.to})).collect::<Vec<_>>(),
        })
        .to_string();
        let wf_id = self
            .store
            .upsert_workflow(&wf.name, wf.version, &snapshot)?;
        let run_id = self.store.create_run(&wf_id, &params)?;

        let (store_tx, store_rx) = mpsc::channel(STORE_CHANNEL_CAPACITY);
        tokio::spawn(run_store_batcher(store_rx, Arc::clone(&self.store)));
        let sink = EventSink {
            run_id: Arc::from(run_id.as_str()),
            seq: Arc::new(AtomicU64::new(0)),
            hub: Arc::clone(&self.hub),
            store_tx,
        };

        let cancel = CancellationToken::new();
        self.runs.lock().unwrap().insert(
            run_id.clone(),
            RunHandle {
                cancel: cancel.clone(),
            },
        );

        let defs: HashMap<String, AgentNodeDef> =
            wf.nodes.iter().map(|n| (n.id.clone(), n.clone())).collect();
        let states: HashMap<String, NodeState> = defs
            .keys()
            .map(|id| (id.clone(), NodeState::Pending))
            .collect();
        let continue_independent = wf_on_failure_is_continue(wf.on_node_failure.as_deref());
        let (result_tx, result_rx) = mpsc::unbounded_channel();
        let driver = Driver {
            run_id: run_id.clone(),
            wf,
            defs,
            params,
            preds,
            sink,
            store: Arc::clone(&self.store),
            executor: Arc::clone(&self.executor),
            sem: Arc::new(Semaphore::new(CONCURRENCY)),
            cancel,
            states,
            values: HashMap::new(),
            inflight: HashMap::new(),
            result_tx,
            result_rx,
            continue_independent,
        };
        tokio::spawn(driver.drive());
        Ok(run_id)
    }

    pub fn cancel_run(&self, run_id: &str) -> Result<(), EngineError> {
        let runs = self.runs.lock().unwrap();
        match runs.get(run_id) {
            Some(handle) => {
                handle.cancel.cancel();
                Ok(())
            }
            None => Err(EngineError::UnknownRun(run_id.to_owned())),
        }
    }

    /// 启动时把上次进程退出遗留的 running run 标记为 interrupted。
    pub fn mark_interrupted_on_boot(&self) {
        match self.store.running_runs() {
            Ok(ids) => {
                for id in ids {
                    if let Err(e) = self.store.set_run_status(&id, "interrupted") {
                        tracing::warn!(run_id = %id, error = %e, "标记 interrupted 失败");
                    }
                }
            }
            Err(e) => tracing::warn!(error = %e, "查询遗留 running run 失败"),
        }
    }
}

/// `on_node_failure` 语义解释：只有显式 `continue_independent` 改变默认 abort 行为。
fn wf_on_failure_is_continue(v: Option<&str>) -> bool {
    match v {
        Some("continue_independent") => true,
        Some(other) => {
            tracing::warn!(value = other, "未知 on_node_failure，按默认 abort_run 处理");
            false
        }
        None => false,
    }
}

/// 节点在 run 内的调度状态。Finished 携带提取后的结构化输出（未包 output 壳）。
enum NodeState {
    Pending,
    Running,
    Finished(Value),
    Skipped,
    Failed(String),
}

/// 节点任务回给驱动任务的结果。
struct NodeDone {
    node_id: String,
    outcome: Result<Value, String>,
}

/// 一个 run 的全部调度状态 + 驱动循环（spec §4.2）。
struct Driver {
    run_id: String,
    wf: WorkflowDef,
    defs: HashMap<String, AgentNodeDef>,
    params: Value,
    /// node_id → 入边 (from, 解析后的条件)。条件求值用 from 节点的提取输出。
    preds: HashMap<String, Vec<(String, Option<Cond>)>>,
    sink: EventSink,
    store: Arc<Store>,
    executor: Arc<dyn NodeExecutor>,
    sem: Arc<Semaphore>,
    cancel: CancellationToken,
    states: HashMap<String, NodeState>,
    /// node_id → 提取输出（未包壳），供条件求值；渲染时再包 {"output": …}。
    values: HashMap<String, Value>,
    inflight: HashMap<String, (tokio::task::JoinHandle<()>, Instant)>,
    result_tx: mpsc::UnboundedSender<NodeDone>,
    result_rx: mpsc::UnboundedReceiver<NodeDone>,
    continue_independent: bool,
}

/// 就绪判定结论。
#[derive(PartialEq)]
enum Fate {
    /// 全部前驱终态且至少一条入边满足（或无入边）——可执行。
    Ready,
    /// 有前驱未终态——等待。
    Wait,
    /// 全部入边永久不可满足（条件为假 / 前驱 skipped/failed）——跳过。
    Skip,
}

impl Driver {
    async fn drive(mut self) {
        self.sink.emit(
            None,
            None,
            EventKind::RunStarted,
            json!({"workflowName": self.wf.name, "params": self.params}),
        );
        loop {
            if self.cancel.is_cancelled() {
                self.shutdown(
                    EventKind::RunCancelled,
                    json!({"reason": "cancelled by user"}),
                    "cancelled",
                    "run cancelled",
                );
                return;
            }

            // 1) 跳过传播到不动点（条件假 / 前驱 skipped 或 failed 级联）
            loop {
                let to_skip: Vec<String> = self
                    .wf
                    .nodes
                    .iter()
                    .filter(|n| matches!(self.states.get(&n.id), Some(NodeState::Pending)))
                    .filter(|n| self.fate(&n.id) == Fate::Skip)
                    .map(|n| n.id.clone())
                    .collect();
                if to_skip.is_empty() {
                    break;
                }
                for id in to_skip {
                    self.sink.emit(
                        Some(&id),
                        None,
                        EventKind::NodeSkipped,
                        json!({"reason": "no satisfiable incoming edges"}),
                    );
                    self.states.insert(id, NodeState::Skipped);
                }
            }

            // 2) 就绪节点全部拉起（并发由信号量约束）
            let ready: Vec<String> = self
                .wf
                .nodes
                .iter()
                .filter(|n| matches!(self.states.get(&n.id), Some(NodeState::Pending)))
                .filter(|n| self.fate(&n.id) == Fate::Ready)
                .map(|n| n.id.clone())
                .collect();
            for id in ready {
                self.spawn_node(&id);
            }

            // 3) 全部终态 → run 终态
            let any_pending = self
                .states
                .values()
                .any(|s| matches!(s, NodeState::Pending));
            if self.inflight.is_empty() {
                if !any_pending {
                    let failures: Vec<&str> = self
                        .wf
                        .nodes
                        .iter()
                        .filter_map(|n| match self.states.get(&n.id) {
                            Some(NodeState::Failed(reason)) => Some(reason.as_str()),
                            _ => None,
                        })
                        .collect();
                    if failures.is_empty() {
                        self.sink
                            .emit(None, None, EventKind::RunFinished, json!({}));
                        self.set_status("finished");
                    } else {
                        self.sink.emit(
                            None,
                            None,
                            EventKind::RunFailed,
                            json!({"reason": failures.join("; ")}),
                        );
                        self.set_status("failed");
                    }
                    return;
                }
                // 有 Pending 却无可推进（有效 DAG 下不可达）——兜底防死循环。
                tracing::error!(run_id = %self.run_id, "调度器停滞");
                self.shutdown(
                    EventKind::RunFailed,
                    json!({"reason": "scheduler stalled"}),
                    "failed",
                    "scheduler stalled",
                );
                return;
            }

            // 4) 等任一节点回执或取消（biased：取消优先于结果）
            let done = tokio::select! {
                biased;
                _ = self.cancel.cancelled() => None,
                done = self.result_rx.recv() => Some(done.expect(
                    "驱动任务持有 result_tx，通道不会在 in-flight 非空时关闭",
                )),
            };
            let Some(done) = done else { continue };
            self.inflight.remove(&done.node_id);
            match done.outcome {
                Ok(value) => {
                    self.states
                        .insert(done.node_id.clone(), NodeState::Finished(value.clone()));
                    self.values.insert(done.node_id.clone(), value.clone());
                    if let Err(e) = self.store.put_artifact(
                        &self.run_id,
                        &done.node_id,
                        "output",
                        "application/json",
                        &value.to_string(),
                    ) {
                        tracing::warn!(run_id = %self.run_id, error = %e, "artifact 写入失败");
                    }
                }
                Err(reason) => {
                    self.states
                        .insert(done.node_id.clone(), NodeState::Failed(reason.clone()));
                    if !self.continue_independent {
                        // 默认 abort_run：取消其余，run.failed
                        self.shutdown(
                            EventKind::RunFailed,
                            json!({"reason": reason}),
                            "failed",
                            "run aborted by node failure",
                        );
                        return;
                    }
                    // continue_independent：失败下游由步骤 1 的跳过传播处理，
                    // 无关分支照常推进
                }
            }
        }
    }

    /// 就绪判定：无入边 → Ready；否则所有入边的前驱须终态——满足（含无条件）
    /// 计数 > 0 → Ready，全部不可满足 → Skip，否则 Wait。
    fn fate(&self, id: &str) -> Fate {
        let Some(edges) = self.preds.get(id) else {
            return Fate::Ready;
        };
        let mut satisfied = 0;
        for (from, cond) in edges {
            match self.states.get(from).expect("边引用已校验的节点") {
                NodeState::Finished(output) => {
                    let ok = match cond {
                        Some(c) => eval_cond(c, output),
                        None => true,
                    };
                    if ok {
                        satisfied += 1;
                    }
                }
                NodeState::Skipped | NodeState::Failed(_) => {}
                NodeState::Pending | NodeState::Running => return Fate::Wait,
            }
        }
        if satisfied > 0 {
            Fate::Ready
        } else {
            Fate::Skip
        }
    }

    fn spawn_node(&mut self, id: &str) {
        let Some(node) = self.defs.get(id).cloned() else {
            return;
        };
        let sink = self.sink.clone();
        let executor = Arc::clone(&self.executor);
        let sem = Arc::clone(&self.sem);
        let params = self.params.clone();
        // 模板按 {{ nodes.<id>.output.<path> }} 取值 → 快照包 {"output": …} 壳
        let outputs: HashMap<String, Value> = self
            .values
            .iter()
            .map(|(k, v)| (k.clone(), json!({"output": v})))
            .collect();
        let result_tx = self.result_tx.clone();
        let run_id = self.run_id.clone();
        let node_id = id.to_owned();
        self.states.insert(node_id.clone(), NodeState::Running);
        let handle = tokio::spawn(async move {
            let _permit = sem.acquire_owned().await;
            let started = Instant::now();
            // M2c：渲染前置——node.started 携带渲染后 prompt（会话视图用户气泡
            // 数据源）。渲染失败路径无 prompt 字段，直接 node.failed。
            let prompt = match render_prompt(&node.prompt, &params, &outputs) {
                Ok(prompt) => prompt,
                Err(e) => {
                    let reason = format!("render: {e}");
                    sink.emit(Some(&node_id), None, EventKind::NodeStarted, json!({}));
                    sink.emit(
                        Some(&node_id),
                        None,
                        EventKind::NodeFailed,
                        json!({
                            "durationMs": started.elapsed().as_millis() as u64,
                            "reason": reason,
                        }),
                    );
                    let _ = result_tx.send(NodeDone {
                        node_id,
                        outcome: Err(reason),
                    });
                    return;
                }
            };
            sink.emit(
                Some(&node_id),
                None,
                EventKind::NodeStarted,
                json!({"prompt": prompt}),
            );
            let outcome =
                run_with_retries(executor.as_ref(), &sink, &node, &run_id, &node_id, &prompt).await;
            let duration_ms = started.elapsed().as_millis() as u64;
            match &outcome {
                Ok(_) => sink.emit(
                    Some(&node_id),
                    None,
                    EventKind::NodeFinished,
                    json!({"durationMs": duration_ms}),
                ),
                Err(reason) => sink.emit(
                    Some(&node_id),
                    None,
                    EventKind::NodeFailed,
                    json!({"durationMs": duration_ms, "reason": reason}),
                ),
            }
            let _ = result_tx.send(NodeDone { node_id, outcome });
        });
        self.inflight
            .insert(id.to_owned(), (handle, Instant::now()));
    }

    /// 终止整个 run：运行中节点 node.cancelled（abort 任务），未启动 node.skipped，
    /// 最后发 run 终态事件并落状态。
    fn shutdown(
        mut self,
        run_kind: EventKind,
        run_payload: serde_json::Value,
        status: &'static str,
        skip_reason: &str,
    ) {
        for (id, (handle, started)) in self.inflight.drain() {
            handle.abort();
            self.sink.emit(
                Some(&id),
                None,
                EventKind::NodeCancelled,
                json!({"durationMs": started.elapsed().as_millis() as u64}),
            );
        }
        for node in &self.wf.nodes {
            if matches!(self.states.get(&node.id), Some(NodeState::Pending)) {
                self.sink.emit(
                    Some(&node.id),
                    None,
                    EventKind::NodeSkipped,
                    json!({"reason": skip_reason}),
                );
                self.states.insert(node.id.clone(), NodeState::Skipped);
            }
        }
        self.sink.emit(None, None, run_kind, run_payload);
        self.set_status(status);
    }

    fn set_status(&self, status: &str) {
        if let Err(e) = self.store.set_run_status(&self.run_id, status) {
            tracing::warn!(run_id = %self.run_id, error = %e, "run 状态落库失败");
        }
    }
}

/// 单节点的执行循环：(执行 → 提取)×，Retryable 按 retry 策略退避重试，
/// Fatal / 提取失败立即终态失败（确定性错误重试无意义）。
/// prompt 已在 spawn_node 渲染成功后才 emit node.started，此处直接复用。
async fn run_with_retries(
    executor: &dyn NodeExecutor,
    sink: &EventSink,
    node: &AgentNodeDef,
    run_id: &str,
    id: &str,
    prompt: &str,
) -> Result<Value, String> {
    let req = ExecRequest {
        run_id: run_id.to_owned(),
        node_id: id.to_owned(),
        agent_key: node.agent.clone(),
        prompt: prompt.to_owned(),
        timeout: node.timeout_ms.map(Duration::from_millis),
    };
    let mut failures: u32 = 0;
    loop {
        match executor.execute(req.clone(), sink).await {
            Ok(message) => {
                return extract_output(&message, node.output_schema.as_ref())
                    .map_err(|e| format!("extraction: {e}"));
            }
            Err(NodeFailure2::Fatal(f)) => return Err(format!("fatal: {f}")),
            Err(NodeFailure2::Retryable(reason)) => {
                failures += 1;
                if failures > node.retry.max {
                    return Err(format!("retries exhausted: {reason}"));
                }
                sink.emit(
                    Some(id),
                    None,
                    EventKind::NodeRetry,
                    json!({"attempt": failures, "max": node.retry.max}),
                );
                tokio::time::sleep(Duration::from_millis(
                    node.retry.backoff_ms.saturating_mul(failures as u64),
                ))
                .await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::RunRow;
    use async_trait::async_trait;
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    /// Mock 执行器：按 node_id 脚本化结果；hang 节点永远挂起（供取消测试）。
    struct MockExecutor {
        outcomes: Mutex<HashMap<String, usize>>,
    }

    impl Default for MockExecutor {
        fn default() -> Self {
            Self {
                outcomes: Mutex::new(HashMap::new()),
            }
        }
    }

    impl MockExecutor {
        fn count_of(mock: &MockExecutor, id: &str) -> usize {
            mock.outcomes.lock().unwrap().get(id).copied().unwrap_or(0)
        }
    }

    #[async_trait]
    impl NodeExecutor for MockExecutor {
        async fn execute(
            &self,
            req: ExecRequest,
            sink: &EventSink,
        ) -> Result<String, NodeFailure2> {
            *self
                .outcomes
                .lock()
                .unwrap()
                .entry(req.node_id.clone())
                .or_insert(0) += 1;
            sink.emit(
                Some(&req.node_id),
                Some("sess_test"),
                EventKind::MsgDelta,
                json!({"delta": "...", "contentType": "text"}),
            );
            match req.node_id.as_str() {
                "ok1" | "ok2" => Ok("{\"ok\": true}".into()),
                "flaky" => {
                    // 第一次失败，重试成功（max=1）
                    let n = *self.outcomes.lock().unwrap().get("flaky").unwrap();
                    if n == 1 {
                        Err(NodeFailure2::Retryable("boom".into()))
                    } else {
                        Ok("{\"ok\": true}".into())
                    }
                }
                "bad" => Err(NodeFailure2::Retryable("always fails".into())),
                "hang" => {
                    std::future::pending::<()>().await;
                    unreachable!("hang 节点永不返回")
                }
                _ => Ok("x".into()),
            }
        }
    }

    fn engine_with(ex: Arc<dyn NodeExecutor>) -> (Arc<Store>, Arc<EventHub>, Arc<Engine>) {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let hub = Arc::new(EventHub::new());
        let engine = Arc::new(Engine::new(Arc::clone(&store), Arc::clone(&hub), ex));
        (store, hub, engine)
    }

    /// 轮询 store 直到 run 到终态（10ms 间隔，5s 上限）。
    async fn wait_terminal(store: &Store, run_id: &str) -> RunRow {
        for _ in 0..500 {
            if let Some(row) = store.get_run(run_id).unwrap() {
                if matches!(row.status.as_str(), "finished" | "failed" | "cancelled") {
                    return row;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("run {run_id} 5s 内未到终态");
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

    /// 等待某节点真正被 MockExecutor 执行到（取消测试需要先确认 hang 已启动）。
    async fn wait_node_executed(mock: &MockExecutor, id: &str) {
        for _ in 0..500 {
            if MockExecutor::count_of(mock, id) > 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("节点 {id} 5s 内未启动");
    }

    #[tokio::test]
    async fn happy_path_linear_and_conditional_skip() {
        let wf = crate::workflow::parse_yaml(
            r#"
meta: {name: t, version: 1}
nodes:
  - {id: ok1, agent: m, prompt: "p1"}
  - {id: ok2, agent: m, prompt: "p2", output_schema: {type: object, required: [ok], properties: {ok: {type: boolean}}}}
  - {id: skipped_child, agent: m, prompt: "p3"}
edges:
  - {from: ok1, to: ok2}
  - {from: ok2, to: skipped_child, when: "output.ok == false"}
"#,
        )
        .unwrap();
        let mock = Arc::new(MockExecutor::default());
        let (store, _hub, engine) = engine_with(Arc::clone(&mock) as Arc<dyn NodeExecutor>);

        let run_id = engine.start_run(wf, json!({})).await.unwrap();
        let row = wait_terminal(&store, &run_id).await;

        assert_eq!(row.status, "finished");
        assert_eq!(MockExecutor::count_of(&mock, "ok1"), 1);
        assert_eq!(MockExecutor::count_of(&mock, "ok2"), 1);
        assert_eq!(
            MockExecutor::count_of(&mock, "skipped_child"),
            0,
            "条件不满足的节点不得执行"
        );

        let evs = drained_events(&store, &run_id).await;
        let skipped: Vec<&FsEvent> = evs
            .iter()
            .filter(|e| e.kind == EventKind::NodeSkipped)
            .collect();
        assert_eq!(skipped.len(), 1, "事件流: {evs:?}");
        assert_eq!(skipped[0].node_id.as_deref(), Some("skipped_child"));
        assert!(
            evs.windows(2).all(|w| w[0].seq < w[1].seq),
            "seq 必须严格递增"
        );
        assert!(evs.iter().all(|e| e.run_id == run_id));
        assert!(
            evs.iter()
                .any(|e| e.kind == EventKind::RunStarted && e.payload["workflowName"] == "t")
        );
        assert!(evs.iter().any(|e| e.kind == EventKind::RunFinished));
        assert!(evs.iter().any(|e| e.kind == EventKind::NodeFinished
            && e.node_id.as_deref() == Some("ok2")
            && e.payload["durationMs"].is_u64()));

        // M2c：node.started 携带渲染后 prompt，且仍是该节点的首个事件。
        for (id, prompt) in [("ok1", "p1"), ("ok2", "p2")] {
            let started = evs
                .iter()
                .find(|e| e.kind == EventKind::NodeStarted && e.node_id.as_deref() == Some(id))
                .unwrap_or_else(|| panic!("{id} 缺 node.started"));
            assert_eq!(
                started.payload["prompt"], prompt,
                "{id} node.started: {started:?}"
            );
        }
    }

    /// M2c：渲染失败路径——node.started 无 prompt 字段，随后 node.failed(reason=render…)；
    /// 节点不得被真正执行。
    #[tokio::test]
    async fn render_failure_emits_started_without_prompt_then_failed() {
        let wf = crate::workflow::parse_yaml(
            r#"
meta: {name: t-render, version: 1}
nodes:
  - {id: bad_tpl, agent: m, prompt: "{{ nodes.missing.output.x }}"}
"#,
        )
        .unwrap();
        let mock = Arc::new(MockExecutor::default());
        let (store, _hub, engine) = engine_with(Arc::clone(&mock) as Arc<dyn NodeExecutor>);

        let run_id = engine.start_run(wf, json!({})).await.unwrap();
        let row = wait_terminal(&store, &run_id).await;
        assert_eq!(row.status, "failed");
        assert_eq!(
            MockExecutor::count_of(&mock, "bad_tpl"),
            0,
            "渲染失败不得执行节点"
        );

        let evs = drained_events(&store, &run_id).await;
        let started = evs
            .iter()
            .find(|e| e.kind == EventKind::NodeStarted && e.node_id.as_deref() == Some("bad_tpl"))
            .expect("渲染失败也应有 node.started");
        assert!(
            started.payload.get("prompt").is_none(),
            "渲染失败路径无 prompt 字段: {started:?}"
        );
        let failed = evs
            .iter()
            .find(|e| e.kind == EventKind::NodeFailed && e.node_id.as_deref() == Some("bad_tpl"))
            .expect("node.failed");
        assert!(
            failed.payload["reason"]
                .as_str()
                .is_some_and(|r| r.contains("render")),
            "reason: {failed:?}"
        );
        assert!(failed.payload["durationMs"].is_u64());
    }

    #[tokio::test]
    async fn retry_then_abort_run_on_persistent_failure() {
        // (a) bad：retry.max=1 → 两次失败 → run failed
        let wf_bad = crate::workflow::parse_yaml(
            r#"
meta: {name: t2a, version: 1}
nodes:
  - {id: bad, agent: m, prompt: "p", retry: {max: 1, backoff_ms: 10}}
"#,
        )
        .unwrap();
        let mock = Arc::new(MockExecutor::default());
        let (store, _hub, engine) = engine_with(Arc::clone(&mock) as Arc<dyn NodeExecutor>);

        let run_a = engine.start_run(wf_bad, json!({})).await.unwrap();
        let row = wait_terminal(&store, &run_a).await;
        assert_eq!(row.status, "failed");
        assert_eq!(MockExecutor::count_of(&mock, "bad"), 2, "初始 + 1 次重试");

        let evs = drained_events(&store, &run_a).await;
        assert!(
            evs.iter()
                .any(|e| e.kind == EventKind::NodeRetry && e.node_id.as_deref() == Some("bad"))
        );
        let failed = evs
            .iter()
            .find(|e| e.kind == EventKind::NodeFailed && e.node_id.as_deref() == Some("bad"))
            .expect("bad 的 node.failed 事件");
        assert!(
            failed.payload["reason"]
                .as_str()
                .is_some_and(|r| r.contains("always fails")),
            "reason: {failed:?}"
        );
        assert!(evs.iter().any(|e| e.kind == EventKind::RunFailed));

        // (b) flaky（同一 engine 再起一个 run）：第一次失败 → node.retry → 重试成功 → finished
        let wf_flaky = crate::workflow::parse_yaml(
            r#"
meta: {name: t2b, version: 1}
nodes:
  - {id: flaky, agent: m, prompt: "p", retry: {max: 1, backoff_ms: 10}}
"#,
        )
        .unwrap();
        let run_b = engine.start_run(wf_flaky, json!({})).await.unwrap();
        let row_b = wait_terminal(&store, &run_b).await;
        assert_eq!(row_b.status, "finished");
        assert_eq!(MockExecutor::count_of(&mock, "flaky"), 2);

        let evs_b = drained_events(&store, &run_b).await;
        assert!(
            evs_b
                .iter()
                .any(|e| e.kind == EventKind::NodeRetry && e.node_id.as_deref() == Some("flaky"))
        );
        assert!(evs_b.iter().any(|e| e.kind == EventKind::NodeFinished
            && e.node_id.as_deref() == Some("flaky")));
    }

    #[tokio::test]
    async fn cancel_run_marks_pending_skipped() {
        let wf = crate::workflow::parse_yaml(
            r#"
meta: {name: t3, version: 1}
nodes:
  - {id: hang, agent: m, prompt: "p"}
  - {id: never, agent: m, prompt: "p"}
edges:
  - {from: hang, to: never}
"#,
        )
        .unwrap();
        let mock = Arc::new(MockExecutor::default());
        let (store, _hub, engine) = engine_with(Arc::clone(&mock) as Arc<dyn NodeExecutor>);

        let run_id = engine.start_run(wf, json!({})).await.unwrap();
        // 先确认 hang 真的启动了，避免 cancel 抢在调度之前产生竞态
        wait_node_executed(&mock, "hang").await;
        engine.cancel_run(&run_id).unwrap();

        let row = wait_terminal(&store, &run_id).await;
        assert_eq!(row.status, "cancelled");
        assert_eq!(MockExecutor::count_of(&mock, "never"), 0);

        let evs = drained_events(&store, &run_id).await;
        assert!(evs.iter().any(|e| e.kind == EventKind::NodeCancelled
            && e.node_id.as_deref() == Some("hang")),
            "运行中的节点应得 node.cancelled: {evs:?}");
        assert!(
            evs.iter()
                .any(|e| e.kind == EventKind::NodeSkipped && e.node_id.as_deref() == Some("never")),
            "未启动的节点应得 node.skipped: {evs:?}"
        );
        assert!(evs.iter().any(|e| e.kind == EventKind::RunCancelled));
    }

    #[tokio::test]
    async fn continue_independent_branches_after_failure() {
        let wf = crate::workflow::parse_yaml(
            r#"
meta: {name: t4, version: 1}
on_node_failure: continue_independent
nodes:
  - {id: ok1, agent: m, prompt: "p1"}
  - {id: bad, agent: m, prompt: "p2"}
  - {id: down, agent: m, prompt: "p3"}
  - {id: ok2, agent: m, prompt: "p4"}
edges:
  - {from: ok1, to: bad}
  - {from: bad, to: down}
  - {from: ok1, to: ok2}
"#,
        )
        .unwrap();
        let mock = Arc::new(MockExecutor::default());
        let (store, _hub, engine) = engine_with(Arc::clone(&mock) as Arc<dyn NodeExecutor>);

        let run_id = engine.start_run(wf, json!({})).await.unwrap();
        let row = wait_terminal(&store, &run_id).await;

        // bad 失败 → run 终态 failed；但独立分支 ok2 照常完成
        assert_eq!(row.status, "failed");
        assert_eq!(MockExecutor::count_of(&mock, "ok1"), 1);
        assert_eq!(MockExecutor::count_of(&mock, "bad"), 1);
        assert_eq!(
            MockExecutor::count_of(&mock, "ok2"),
            1,
            "独立分支必须继续执行"
        );
        assert_eq!(MockExecutor::count_of(&mock, "down"), 0, "失败下游必须跳过");

        let evs = drained_events(&store, &run_id).await;
        assert!(
            evs.iter()
                .any(|e| e.kind == EventKind::NodeFailed && e.node_id.as_deref() == Some("bad"))
        );
        assert!(
            evs.iter()
                .any(|e| e.kind == EventKind::NodeSkipped && e.node_id.as_deref() == Some("down"))
        );
        assert!(
            evs.iter()
                .any(|e| e.kind == EventKind::NodeFinished && e.node_id.as_deref() == Some("ok2"))
        );
        assert!(evs.iter().any(|e| e.kind == EventKind::RunFailed));
    }
}
