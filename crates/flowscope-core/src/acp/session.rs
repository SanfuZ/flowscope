//! One ACP node run: spawn the agent process, initialize, `session/new`,
//! `session/prompt`, and translate the traffic into unified events.
//!
//! Mapping contracts (design spec §3.2–§3.4, controller rulings R4/R7/R8):
//!
//! - `agent_message_chunk`(text) / `agent_thought_chunk` → `msg.delta`
//!   `{"delta", "contentType": "text"|"reasoning"}`
//! - `tool_call` / `tool_call_update` → `tool.update`
//!   `{"toolCallId", "title", "kind", "status", "content"?}` (state merged per
//!   tool call id; ACP status `failed` is reported as `"error"`)
//! - `plan` → `plan.snapshot` `{"entries": [{"content", "priority", "status"}]}`
//! - `current_mode_update` / `available_commands_update` → `session.meta`
//! - child stderr lines → `log.lines` `{"lines": [...], "level": "info"}`
//!   (batched per read)
//! - client-side callback decisions → `callback` / `permission` events
//! - `stopReason`: `end_turn` → `Ok(last message)`; `cancelled` →
//!   `ProcessExit("cancelled")`; `refusal` → `Refusal`; `max_tokens` /
//!   `max_turn_requests` → `MaxTokens`.

use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use agent_client_protocol as acp;
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    ClientCapabilities, ContentBlock, CreateTerminalRequest, FileSystemCapabilities,
    Implementation, InitializeRequest, KillTerminalRequest, PermissionOption, PermissionOptionId,
    PermissionOptionKind, Plan, ReadTextFileRequest, ReadTextFileResponse, ReleaseTerminalRequest,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionNotification, SessionUpdate, StopReason,
    TerminalOutputRequest, WaitForTerminalExitRequest, WriteTextFileRequest,
};
use agent_client_protocol::util::MatchDispatch;
use agent_client_protocol::{Client, LineDirection, SessionMessage};
use serde_json::{Value, json};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};

use super::registry::{AgentConfig, PermissionDefault};
use crate::events::{EventKind, FsEvent};

/// One agent-node execution request.
#[derive(Debug, Clone)]
pub struct NodeRequest {
    pub run_id: String,
    pub node_id: String,
    pub session_id: String,
    pub prompt: String,
    /// Wall-clock budget for the whole node (initialize + prompt turn).
    /// `None` falls back to [`DEFAULT_NODE_TIMEOUT`].
    pub timeout: Option<Duration>,
}

/// How one agent-node run failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NodeFailure {
    /// The agent process died, the transport broke, or the protocol errored.
    /// Carries the error and the captured stderr tail.
    #[error("agent process failed: {0}")]
    ProcessExit(String),
    /// The node exceeded its time budget; the agent process group was killed.
    #[error("node timed out")]
    Timeout,
    /// The agent refused to continue (`stopReason: refusal`).
    #[error("agent refused the prompt")]
    Refusal,
    /// The agent hit its token/turn-request limit (`stopReason: max_tokens`
    /// or `max_turn_requests`).
    #[error("agent hit token/turn limit")]
    MaxTokens,
}

/// Timeout used when a [`NodeRequest`] carries none.
pub const DEFAULT_NODE_TIMEOUT: Duration = Duration::from_secs(600);

/// How many stderr lines are kept for [`NodeFailure::ProcessExit`] details.
const STDERR_TAIL_LINES: usize = 10;

/// Shared per-run state: event attribution, the seq counter, the channel that
/// carries client-callback decisions from connection handlers back to the
/// session loop, and the stderr tail buffer.
struct RunState {
    run_id: String,
    node_id: Option<String>,
    session_id: Option<String>,
    seq: AtomicU64,
    event_tx: UnboundedSender<FsEvent>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    /// Whitelist root for `fs/read_text_file`; `None` allows any path.
    fs_root: Option<PathBuf>,
    permission_default: PermissionDefault,
}

impl RunState {
    fn emit(&self, kind: EventKind, payload: Value) -> FsEvent {
        FsEvent {
            seq: self.seq.fetch_add(1, Ordering::Relaxed),
            ts: chrono::Utc::now(),
            run_id: self.run_id.clone(),
            node_id: self.node_id.clone(),
            session_id: self.session_id.clone(),
            kind,
            payload,
        }
    }

    /// Used from connection handlers (which cannot touch the sink directly):
    /// the session loop drains `event_rx` and forwards to the sink.
    fn emit_via_channel(&self, kind: EventKind, payload: Value) {
        let _ = self.event_tx.send(self.emit(kind, payload));
    }

    fn stderr_tail_joined(&self) -> String {
        self.stderr_tail
            .lock()
            .expect("stderr tail lock poisoned")
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join(" | ")
    }

    /// Wraps a crate error into [`NodeFailure::ProcessExit`], enriched with
    /// the agent stderr tail captured so far.
    fn process_exit(&self, err: &acp::Error) -> NodeFailure {
        let tail = self.stderr_tail_joined();
        let detail = if tail.is_empty() {
            format!("{err}")
        } else {
            format!("{err}; agent stderr tail: {tail}")
        };
        NodeFailure::ProcessExit(detail)
    }

    fn callback_event(&self, method: &str, allowed: bool, detail: String) {
        self.emit_via_channel(
            EventKind::Callback,
            json!({"method": method, "allowed": allowed, "detail": detail}),
        );
    }

    /// `fs/read_text_file` policy (spec §3.3): allowed only inside the agent's
    /// configured cwd; no configured cwd means no restriction.
    fn fs_read_allowed(&self, path: &Path) -> bool {
        match &self.fs_root {
            None => true,
            Some(root) => path.starts_with(root),
        }
    }
}

/// Latest merged fields of one tool call, so `tool_call_update` events can
/// carry a complete payload even though ACP updates are partial.
#[derive(Debug, Clone)]
struct ToolFields {
    title: String,
    kind: String,
    status: String,
    content: Option<Vec<Value>>,
}

/// Tracks message/tool state across one prompt turn.
#[derive(Debug, Default)]
struct TurnState {
    tools: BTreeMap<String, ToolFields>,
    /// `messageId` of the message currently being streamed, when the agent
    /// tags its chunks.
    current_message_id: Option<String>,
    /// Text of the last complete agent message — the node output candidate.
    last_message: String,
}

impl TurnState {
    /// Groups chunk text into messages by `messageId` (spec: same id = same
    /// message). Untagged chunks cannot be grouped, so each counts as its own
    /// message; the mock agent relies on this (its `final_message` chunk must
    /// be the whole node output).
    fn push_agent_text(&mut self, message_id: &Option<String>, text: &str) {
        let same_message = match (&self.current_message_id, message_id) {
            (Some(current), Some(new)) => current == new,
            _ => false,
        };
        if same_message {
            self.last_message.push_str(text);
        } else {
            self.last_message = text.to_owned();
            self.current_message_id = message_id.clone();
        }
    }
}

/// Runs one workflow agent node against the configured ACP agent.
///
/// Spawns the agent (via `AcpAgent`), initializes the connection, opens one
/// session, sends the prompt, and streams every `session/update`, every
/// client-callback policy decision, and every child stderr line to `sink` as
/// [`FsEvent`]s. Resolves with the text of the agent's last complete message
/// on `end_turn`, or a [`NodeFailure`] describing how the node failed.
///
/// On timeout the connection future is dropped, which terminates the spawned
/// agent process group (crate semantics), and `Err(NodeFailure::Timeout)` is
/// returned.
pub async fn run_agent_node(
    cfg: &AgentConfig,
    req: &NodeRequest,
    sink: &dyn Fn(FsEvent),
) -> Result<String, NodeFailure> {
    let Some((program, args)) = cfg.command.split_first() else {
        return Err(NodeFailure::ProcessExit(format!(
            "agent {}: empty command",
            cfg.key
        )));
    };

    let (event_tx, mut event_rx) = unbounded_channel::<FsEvent>();
    let (stderr_tx, mut stderr_rx) = unbounded_channel::<String>();
    let state = Arc::new(RunState {
        run_id: req.run_id.clone(),
        node_id: Some(req.node_id.clone()),
        session_id: Some(req.session_id.clone()),
        seq: AtomicU64::new(0),
        event_tx,
        stderr_tail: Arc::new(Mutex::new(VecDeque::new())),
        fs_root: cfg.cwd.clone(),
        permission_default: cfg.permission_default,
    });

    // stderr → LogLines: AcpAgent::with_debug hands us every stderr line
    // (already split and truncated by the crate); forward into a channel that
    // the session loop batches into one event per read, and keep a tail for
    // failure details.
    let agent = acp::AcpAgent::new(
        acp::AcpAgentConfig::new(program.clone())
            .args(args)
            .envs(cfg.env.iter()),
    )
    .with_debug({
        let stderr_tx = stderr_tx.clone();
        let tail = state.stderr_tail.clone();
        move |line, direction| {
            if direction == LineDirection::Stderr && !line.trim().is_empty() {
                let line = line.trim_end_matches('\r').to_owned();
                let mut tail = tail.lock().expect("stderr tail lock poisoned");
                if tail.len() >= STDERR_TAIL_LINES {
                    tail.pop_front();
                }
                tail.push_back(line.clone());
                drop(tail);
                let _ = stderr_tx.send(line);
            }
        }
    });

    let client = policy_client(state.clone());

    let session_cwd = cfg
        .cwd
        .clone()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));

    let connect = client.connect_with(agent, async |cx| {
        // v1 has no auto-initialize: send `initialize` ourselves. Every early
        // exit below yields the inner `Result<String, NodeFailure>` so the
        // crate-level error channel stays reserved for transport failures.
        let init = match cx.send_request(initialize_request()).block_task().await {
            Ok(init) => init,
            Err(e) => return Ok(Err(state.process_exit(&e))),
        };
        if init.protocol_version != ProtocolVersion::V1 {
            tracing::warn!(
                version = ?init.protocol_version,
                "agent negotiated a protocol version other than v1; continuing anyway"
            );
        }

        let turn = cx
            .build_session(&session_cwd)
            .block_task()
            .run_until(async |mut session| {
                if let Err(e) = session.send_prompt(req.prompt.clone()) {
                    return Ok(Err(state.process_exit(&e)));
                }

                let mut turn = TurnState::default();
                let mut stderr_open = true;
                let mut events_open = true;
                let outcome: Result<String, NodeFailure> = loop {
                    tokio::select! {
                        biased;
                        line = stderr_rx.recv(), if stderr_open => match line {
                            Some(first) => {
                                let mut lines = vec![first];
                                while let Ok(more) = stderr_rx.try_recv() {
                                    lines.push(more);
                                }
                                sink(state.emit(
                                    EventKind::LogLines,
                                    json!({"lines": lines, "level": "info"}),
                                ));
                            }
                            None => stderr_open = false,
                        },
                        event = event_rx.recv(), if events_open => match event {
                            Some(event) => sink(event),
                            None => events_open = false,
                        },
                        message = session.read_update() => match message {
                            Err(e) => break Err(state.process_exit(&e)),
                            Ok(SessionMessage::StopReason(reason)) => {
                                break map_stop_reason(reason, turn.last_message.clone());
                            }
                            Ok(SessionMessage::SessionMessage(dispatch)) => {
                                if let Err(e) =
                                    handle_dispatch(&state, dispatch, &mut turn, sink).await
                                {
                                    break Err(state.process_exit(&e));
                                }
                                // Flush callback decisions queued while the
                                // dispatch was being handled.
                                while let Ok(event) = event_rx.try_recv() {
                                    sink(event);
                                }
                            }
                            // SessionMessage is non_exhaustive; unknown
                            // variants end the turn rather than being lost.
                            Ok(other) => {
                                break Err(NodeFailure::ProcessExit(format!(
                                    "unexpected session message {other:?}"
                                )));
                            }
                        },
                    }
                };
                Ok(outcome)
            })
            .await;
        match turn {
            Ok(inner) => Ok(inner),
            Err(e) => Ok(Err(state.process_exit(&e))),
        }
    });

    match tokio::time::timeout(req.timeout.unwrap_or(DEFAULT_NODE_TIMEOUT), connect).await {
        // Dropping `connect` on timeout tears the transport down, which kills
        // the spawned agent process (group).
        Err(_elapsed) => Err(NodeFailure::Timeout),
        Ok(Ok(Ok(text))) => Ok(text),
        Ok(Ok(Err(failure))) => Err(failure),
        Ok(Err(e)) => Err(state.process_exit(&e)),
    }
}

/// Builds the client-side of the connection with all agent→client request
/// handlers registered (spec §3.3 policies). Every decision is emitted as a
/// `callback` or `permission` event.
fn policy_client(
    state: Arc<RunState>,
) -> acp::Builder<Client, impl acp::HandleDispatchFrom<acp::Agent>> {
    let fs_state = state.clone();
    let write_state = state.clone();

    Client.builder()
        .name("flowscope")
        // fs/read_text_file: allow only within the agent cwd whitelist.
        .on_receive_request(
            async move |req: ReadTextFileRequest, responder, _cx| {
                let path = req.path.clone();
                if !fs_state.fs_read_allowed(&path) {
                    fs_state.callback_event(
                        "fs/read_text_file",
                        false,
                        format!("{}: outside agent cwd whitelist", path.display()),
                    );
                    return responder.respond_with_error(
                        acp::Error::invalid_request().data(format!(
                            "flowscope policy: {} is outside the agent cwd",
                            path.display()
                        )),
                    );
                }
                match read_text_file(&req) {
                    Ok(content) => {
                        fs_state.callback_event(
                            "fs/read_text_file",
                            true,
                            path.display().to_string(),
                        );
                        responder.respond(ReadTextFileResponse::new(content))
                    }
                    Err(e) => {
                        fs_state.callback_event(
                            "fs/read_text_file",
                            false,
                            format!("{}: {e}", path.display()),
                        );
                        responder.respond_with_error(acp::Error::internal_error().data(format!(
                            "cannot read {}: {e}",
                            path.display()
                        )))
                    }
                }
            },
            acp::on_receive_request!(),
        )
        // fs/write_text_file: always denied (MVP).
        .on_receive_request(
            async move |req: WriteTextFileRequest, responder, _cx| {
                write_state.callback_event(
                    "fs/write_text_file",
                    false,
                    format!("{}: writes denied by policy", req.path.display()),
                );
                responder.respond_with_error(
                    acp::Error::invalid_request()
                        .data("flowscope policy: fs/write_text_file is denied"),
                )
            },
            acp::on_receive_request!(),
        )
        // terminal/*: always denied (MVP).
        .on_receive_request(
            {
                let state = state.clone();
                async move |req: CreateTerminalRequest, responder, _cx| {
                    deny_terminal(&state, "terminal/create", &req.command, responder)
                }
            },
            acp::on_receive_request!(),
        )
        .on_receive_request(
            {
                let state = state.clone();
                async move |_req: TerminalOutputRequest, responder, _cx| {
                    deny_terminal(&state, "terminal/output", "", responder)
                }
            },
            acp::on_receive_request!(),
        )
        .on_receive_request(
            {
                let state = state.clone();
                async move |_req: ReleaseTerminalRequest, responder, _cx| {
                    deny_terminal(&state, "terminal/release", "", responder)
                }
            },
            acp::on_receive_request!(),
        )
        .on_receive_request(
            {
                let state = state.clone();
                async move |_req: WaitForTerminalExitRequest, responder, _cx| {
                    deny_terminal(&state, "terminal/wait_for_exit", "", responder)
                }
            },
            acp::on_receive_request!(),
        )
        .on_receive_request(
            {
                let state = state.clone();
                async move |_req: KillTerminalRequest, responder, _cx| {
                    deny_terminal(&state, "terminal/kill", "", responder)
                }
            },
            acp::on_receive_request!(),
        )
        // session/request_permission: auto-answer per agent config.
        .on_receive_request(
            {
                let state = state.clone();
                async move |req: RequestPermissionRequest, responder, _cx| {
                    let tool_call_id = req.tool_call.tool_call_id.to_string();
                    match decide_permission(&state, &req.options) {
                        Some((option_id, allowed)) => {
                            state.emit_via_channel(
                                EventKind::Permission,
                                json!({
                                    "toolCallId": tool_call_id,
                                    "optionId": option_id.to_string(),
                                    "auto": true,
                                    "allowed": allowed,
                                }),
                            );
                            responder.respond(RequestPermissionResponse::new(
                                RequestPermissionOutcome::Selected(
                                    SelectedPermissionOutcome::new(option_id),
                                ),
                            ))
                        }
                        None => {
                            state.emit_via_channel(
                                EventKind::Permission,
                                json!({
                                    "toolCallId": tool_call_id,
                                    "optionId": Value::Null,
                                    "auto": true,
                                    "allowed": false,
                                    "detail": "no option matching the configured permission_default",
                                }),
                            );
                            responder.respond_with_error(
                                acp::Error::invalid_request().data(
                                    "flowscope policy: no permission option matches \
                                     permission_default",
                                ),
                            )
                        }
                    }
                }
            },
            acp::on_receive_request!(),
        )
}

fn deny_terminal<Resp: acp::JsonRpcResponse>(
    state: &RunState,
    method: &str,
    detail: &str,
    responder: acp::Responder<Resp>,
) -> Result<(), acp::Error> {
    state.callback_event(
        method,
        false,
        format!("{detail}: terminals denied by policy"),
    );
    responder.respond_with_error(
        acp::Error::invalid_request().data(format!("flowscope policy: {method} is denied")),
    )
}

/// Picks the permission option matching the configured default.
/// `allow_once` selects the first allow-kind option, `deny` the first
/// reject-kind option; `None` when the agent offered no matching option.
fn decide_permission(
    state: &RunState,
    options: &[PermissionOption],
) -> Option<(PermissionOptionId, bool)> {
    let wants_allow = matches!(state.permission_default, PermissionDefault::AllowOnce);
    options
        .iter()
        .find(|option| option_matches(option.kind, wants_allow))
        .map(|option| (option.option_id.clone(), wants_allow))
}

fn option_matches(kind: PermissionOptionKind, wants_allow: bool) -> bool {
    matches!(
        (kind, wants_allow),
        (
            PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways,
            true
        ) | (
            PermissionOptionKind::RejectOnce | PermissionOptionKind::RejectAlways,
            false
        )
    )
}

/// Reads the requested file, honoring the 1-based `line`/`limit` options.
fn read_text_file(req: &ReadTextFileRequest) -> std::io::Result<String> {
    let content = std::fs::read_to_string(&req.path)?;
    let skip = req.line.unwrap_or(1).saturating_sub(1) as usize;
    let lines: Vec<&str> = content.lines().skip(skip).collect();
    let selected: Vec<&str> = match req.limit {
        Some(limit) => lines.into_iter().take(limit as usize).collect(),
        None => lines,
    };
    let mut out = selected.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    Ok(out)
}

fn initialize_request() -> InitializeRequest {
    let fs = FileSystemCapabilities::new().read_text_file(true);
    InitializeRequest::new(ProtocolVersion::V1)
        .client_capabilities(ClientCapabilities::new().fs(fs))
        .client_info(Implementation::new("flowscope", "0.1.0"))
}

fn map_stop_reason(reason: StopReason, last_message: String) -> Result<String, NodeFailure> {
    match reason {
        StopReason::EndTurn => Ok(last_message),
        StopReason::Cancelled => Err(NodeFailure::ProcessExit("cancelled".into())),
        StopReason::Refusal => Err(NodeFailure::Refusal),
        StopReason::MaxTokens | StopReason::MaxTurnRequests => Err(NodeFailure::MaxTokens),
        other => Err(NodeFailure::ProcessExit(format!(
            "unexpected stop reason {other:?}"
        ))),
    }
}

/// Routes one agent dispatch through the `session/update` → event mapping.
async fn handle_dispatch(
    state: &RunState,
    dispatch: acp::Dispatch,
    turn: &mut TurnState,
    sink: &dyn Fn(FsEvent),
) -> Result<(), acp::Error> {
    MatchDispatch::new(dispatch)
        .if_notification(async |notification: SessionNotification| {
            map_update(state, &notification.update, turn, sink);
            Ok(())
        })
        .await
        .otherwise_ignore()
}

fn map_update(
    state: &RunState,
    update: &SessionUpdate,
    turn: &mut TurnState,
    sink: &dyn Fn(FsEvent),
) {
    let emit = |kind, payload| sink(state.emit(kind, payload));
    match update {
        SessionUpdate::AgentMessageChunk(chunk) => {
            if let ContentBlock::Text(text) = &chunk.content {
                let message_id = chunk.message_id.as_ref().map(|id| id.to_string());
                turn.push_agent_text(&message_id, &text.text);
                emit(
                    EventKind::MsgDelta,
                    json!({"delta": text.text, "contentType": "text"}),
                );
            }
        }
        SessionUpdate::AgentThoughtChunk(chunk) => {
            if let ContentBlock::Text(text) = &chunk.content {
                emit(
                    EventKind::MsgDelta,
                    json!({"delta": text.text, "contentType": "reasoning"}),
                );
            }
        }
        // user_message_chunk is an echo of our own prompt; spec §3.4 maps only
        // agent chunks, so it is ignored.
        SessionUpdate::UserMessageChunk(_) => {}
        SessionUpdate::ToolCall(call) => {
            let entry = turn
                .tools
                .entry(call.tool_call_id.to_string())
                .or_insert_with(|| ToolFields {
                    title: call.title.clone(),
                    kind: "other".into(),
                    status: "pending".into(),
                    content: None,
                });
            entry.title = call.title.clone();
            entry.kind = tool_kind_string(&call.kind);
            if let Some(status) = tool_status_string(&call.status) {
                entry.status = status.to_owned();
            }
            if !call.content.is_empty() {
                entry.content = Some(content_blocks(&call.content));
            }
            emit_tool_update(state, &call.tool_call_id.to_string(), entry, sink);
        }
        SessionUpdate::ToolCallUpdate(update) => {
            let id = update.tool_call_id.to_string();
            let entry = turn.tools.entry(id.clone()).or_insert_with(|| ToolFields {
                title: id.clone(),
                kind: "other".into(),
                status: "pending".into(),
                content: None,
            });
            let fields = &update.fields;
            if let Some(title) = &fields.title {
                entry.title = title.clone();
            }
            if let Some(kind) = &fields.kind {
                entry.kind = tool_kind_string(kind);
            }
            if let Some(status) = fields.status.as_ref().and_then(tool_status_string) {
                entry.status = status.to_owned();
            }
            if let Some(content) = &fields.content {
                entry.content = Some(content_blocks(content));
            }
            emit_tool_update(state, &id, entry, sink);
        }
        SessionUpdate::Plan(plan) => {
            sink(state.emit(EventKind::PlanSnapshot, plan_payload(plan)));
        }
        SessionUpdate::CurrentModeUpdate(mode) => {
            sink(state.emit(
                EventKind::SessionMeta,
                json!({"currentMode": mode.current_mode_id.to_string()}),
            ));
        }
        SessionUpdate::AvailableCommandsUpdate(commands) => {
            sink(state.emit(
                EventKind::SessionMeta,
                json!({"availableCommands": serde_json::to_value(&commands.available_commands)
                    .unwrap_or(Value::Null)}),
            ));
        }
        // config_option_update / session_info_update / usage_update and any
        // future variants have no unified-event mapping yet.
        _ => {}
    }
}

fn emit_tool_update(state: &RunState, id: &str, entry: &ToolFields, sink: &dyn Fn(FsEvent)) {
    let mut payload = json!({
        "toolCallId": id,
        "title": entry.title,
        "kind": entry.kind,
        "status": entry.status,
    });
    if let Some(content) = &entry.content {
        payload["content"] = json!(content);
    }
    sink(state.emit(EventKind::ToolUpdate, payload));
}

/// ACP `Plan` → `plan.snapshot` payload. Entries are the flat ACP shape
/// (`content`/`priority`/`status`, no id).
fn plan_payload(plan: &Plan) -> Value {
    let entries: Vec<Value> = plan
        .entries
        .iter()
        .map(|entry| {
            json!({
                "content": entry.content,
                "priority": serde_json::to_value(&entry.priority).unwrap_or(Value::Null),
                "status": serde_json::to_value(&entry.status).unwrap_or(Value::Null),
            })
        })
        .collect();
    json!({"entries": entries})
}

fn content_blocks(content: &[agent_client_protocol::schema::v1::ToolCallContent]) -> Vec<Value> {
    content
        .iter()
        .filter_map(|block| serde_json::to_value(block).ok())
        .collect()
}

/// R4 contract status strings. ACP `failed` is reported as `"error"`; unknown
/// (future) statuses keep the previous value.
fn tool_status_string(
    status: &agent_client_protocol::schema::v1::ToolCallStatus,
) -> Option<&'static str> {
    match status {
        agent_client_protocol::schema::v1::ToolCallStatus::Pending => Some("pending"),
        agent_client_protocol::schema::v1::ToolCallStatus::InProgress => Some("in_progress"),
        agent_client_protocol::schema::v1::ToolCallStatus::Completed => Some("completed"),
        agent_client_protocol::schema::v1::ToolCallStatus::Failed => Some("error"),
        _ => None,
    }
}

fn tool_kind_string(kind: &agent_client_protocol::schema::v1::ToolKind) -> String {
    serde_json::to_value(kind)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "other".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::EventKind;
    use std::sync::{Arc, Mutex};

    fn mock_script(name: &str) -> String {
        format!(
            "{}/../flowscope-mock-agent/examples/{name}",
            env!("CARGO_MANIFEST_DIR")
        )
    }

    /// Locates the mock agent binary through `assert_cmd`. assert_cmd 2.x only
    /// *locates* (`CARGO_BIN_EXE_*` / target-dir scan — cross-crate there is
    /// no env var, so the workspace bin must already be built), so build it
    /// once per test-binary run first; this also guarantees freshness instead
    /// of picking up a stale `target/debug` artifact.
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

    fn mock_cfg(script: &str) -> AgentConfig {
        AgentConfig {
            key: "mock".into(),
            name: "Mock".into(),
            command: vec![mock_exe().to_owned(), "--script".into(), script.to_owned()],
            cwd: None,
            env: Default::default(),
            default_mode: None,
            permission_default: super::super::registry::PermissionDefault::Deny,
        }
    }

    fn collect() -> (Arc<Mutex<Vec<FsEvent>>>, impl Fn(FsEvent)) {
        let events: Arc<Mutex<Vec<FsEvent>>> = Arc::new(Mutex::new(vec![]));
        let sink = {
            let events = events.clone();
            move |e: FsEvent| events.lock().unwrap().push(e)
        };
        (events, sink)
    }

    fn req(prompt: &str, timeout_ms: u64) -> NodeRequest {
        NodeRequest {
            run_id: "run_t8".into(),
            node_id: "node_collect".into(),
            session_id: "sess_1".into(),
            prompt: prompt.into(),
            timeout: Some(Duration::from_millis(timeout_ms)),
        }
    }

    #[tokio::test]
    async fn runs_mock_agent_and_emits_expected_events() {
        let (events, sink) = collect();
        let cfg = mock_cfg(&mock_script("demo-script.yaml"));
        let msg = run_agent_node(&cfg, &req("hi", 10_000), &sink)
            .await
            .unwrap();
        assert_eq!(msg, r#"{"ok": true, "data_path": "out/report.md"}"#);

        let ev = events.lock().unwrap();
        let kinds: Vec<EventKind> = ev.iter().map(|e| e.kind).collect();
        assert!(kinds.contains(&EventKind::MsgDelta), "kinds: {kinds:?}");
        assert!(kinds.contains(&EventKind::ToolUpdate), "kinds: {kinds:?}");
        assert!(kinds.contains(&EventKind::PlanSnapshot), "kinds: {kinds:?}");
        assert!(kinds.contains(&EventKind::LogLines), "kinds: {kinds:?}");
        assert!(
            kinds
                .iter()
                .filter(|k| **k == EventKind::ToolUpdate)
                .count()
                >= 2
        );

        // Every event is fully attributed and strictly ordered within the node.
        for e in ev.iter() {
            assert_eq!(e.run_id, "run_t8");
            assert_eq!(e.node_id.as_deref(), Some("node_collect"));
            assert_eq!(e.session_id.as_deref(), Some("sess_1"));
        }
        assert!(ev.windows(2).all(|w| w[0].seq < w[1].seq));

        // Tool lifecycle carried through: in_progress → completed with content.
        let completed = ev
            .iter()
            .find(|e| {
                e.kind == EventKind::ToolUpdate
                    && e.payload.get("status").and_then(|s| s.as_str()) == Some("completed")
            })
            .expect("completed ToolUpdate");
        assert_eq!(completed.payload["toolCallId"], "t1");
        assert_eq!(completed.payload["title"], "查询数据库");
        assert_eq!(
            completed.payload["content"][0],
            serde_json::json!({"type": "content", "content": {"type": "text", "text": "rows: 3"}})
        );

        // Plan snapshot uses the flat ACP entry shape (no id).
        let plan = ev
            .iter()
            .find(|e| e.kind == EventKind::PlanSnapshot)
            .unwrap();
        assert_eq!(plan.payload["entries"][0]["content"], "收集数据");
        assert!(plan.payload["entries"][0].get("id").is_none());

        // stderr lines arrived as one LogLines event with level info.
        let logs = ev.iter().find(|e| e.kind == EventKind::LogLines).unwrap();
        assert_eq!(logs.payload["level"], "info");
        assert_eq!(logs.payload["lines"][0], "mock agent starting");
    }

    #[tokio::test]
    async fn crashed_agent_maps_to_process_exit_with_stderr_tail() {
        let (_events, sink) = collect();
        let cfg = mock_cfg(&mock_script("crash-script.yaml"));
        let err = run_agent_node(&cfg, &req("hi", 10_000), &sink)
            .await
            .unwrap_err();
        match err {
            NodeFailure::ProcessExit(detail) => {
                assert!(!detail.is_empty());
            }
            other => panic!("expected ProcessExit, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn refusal_stop_reason_maps_to_refusal_failure() {
        // Minimal inline script: no steps, refuse immediately.
        let script =
            std::env::temp_dir().join(format!("flowscope-refusal-{}.yaml", uuid::Uuid::new_v4()));
        std::fs::write(&script, "steps: []\nstop: refusal\n").unwrap();
        let (events, sink) = collect();
        let cfg = mock_cfg(&script.to_string_lossy());
        let err = run_agent_node(&cfg, &req("hi", 10_000), &sink)
            .await
            .unwrap_err();
        assert_eq!(err, NodeFailure::Refusal);
        assert!(
            events
                .lock()
                .unwrap()
                .iter()
                .all(|e| e.kind != EventKind::MsgDelta)
        );
    }

    #[tokio::test]
    async fn slow_agent_times_out_and_kills_child() {
        let script =
            std::env::temp_dir().join(format!("flowscope-slow-{}.yaml", uuid::Uuid::new_v4()));
        std::fs::write(
            &script,
            "steps:\n  - {delay_ms: 30000, message: slow}\nstop: end_turn\n",
        )
        .unwrap();
        let (_events, sink) = collect();
        let cfg = mock_cfg(&script.to_string_lossy());
        let start = std::time::Instant::now();
        let err = run_agent_node(&cfg, &req("hi", 500), &sink)
            .await
            .unwrap_err();
        assert_eq!(err, NodeFailure::Timeout);
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "timeout must not wait on the child"
        );
    }
}
