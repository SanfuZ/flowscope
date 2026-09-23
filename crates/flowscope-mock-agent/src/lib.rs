//! Script-driven mock ACP (Agent Client Protocol v1) agent.
//!
//! Speaks hand-rolled JSON-RPC 2.0 over line-delimited stdio (deliberately not
//! using the `agent-client-protocol` crate, so this binary doubles as a
//! wire-level compatibility check against `flowscope-core`).
//!
//! Wire field names follow the official v1 schema at
//! <https://agentclientprotocol.com/protocol/v1/schema> as packaged in
//! `agent-client-protocol-schema` (the same schema `agent-client-protocol`
//! 2.2 serializes/deserializes with).
//!
//! Protocol behavior:
//! - `initialize` / `session/new` are answered immediately.
//! - `session/prompt` first streams the script's steps as `session/update`
//!   notifications (honoring `delay_ms`), then answers the prompt request with
//!   `{stopReason: <stop>}`.
//! - stdin EOF exits 0; unknown methods get `-32601`; malformed JSON lines are
//!   skipped.
//! - Every stdout write is a single line flushed immediately.

use std::collections::HashSet;
use std::io::{BufRead, Write};
use std::path::Path;
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

/// Fixed session id this mock hands out for `session/new`.
const SESSION_ID: &str = "mock-s1";

/// Crash exit code used by the `crash_after` failure-injection knob.
const CRASH_EXIT_CODE: i32 = 3;

/// Exit code for startup errors (unreadable/invalid script, bad usage).
const STARTUP_EXIT_CODE: i32 = 2;

/// Valid `StopReason` values (spec adds `max_turn_requests` beyond the 4 the
/// task brief sketched).
const STOP_REASONS: [&str; 5] = [
    "end_turn",
    "cancelled",
    "refusal",
    "max_tokens",
    "max_turn_requests",
];

const TOOL_CALL_STATUSES: [&str; 4] = ["pending", "in_progress", "completed", "failed"];
const PLAN_ENTRY_STATUSES: [&str; 3] = ["pending", "in_progress", "completed"];
const PLAN_ENTRY_PRIORITIES: [&str; 3] = ["high", "medium", "low"];

/// The mock script: fully determines the agent's behavior.
#[derive(Debug, Deserialize)]
struct Script {
    #[serde(default)]
    steps: Vec<Step>,
    /// Emitted as one final `agent_message_chunk` after all steps.
    #[serde(default)]
    final_message: Option<String>,
    /// `stopReason` used to answer `session/prompt`.
    #[serde(default = "default_stop")]
    stop: String,
    /// 1-based step index; after executing that step the process prints to
    /// stderr and exits with code 3 (failure injection).
    #[serde(default)]
    crash_after: Option<usize>,
    /// Lines printed to stderr at startup.
    #[serde(default)]
    stderr_lines: Vec<String>,
}

fn default_stop() -> String {
    "end_turn".to_owned()
}

/// One scripted step. Fields are applied in declaration order when present.
#[derive(Debug, Default, Deserialize)]
struct Step {
    /// Sleep this long before applying the rest of the step.
    #[serde(default)]
    delay_ms: Option<u64>,
    /// Emit an `agent_message_chunk` with this text.
    #[serde(default)]
    message: Option<String>,
    /// Emit a `tool_call` (first sight of the id) or `tool_call_update`.
    #[serde(default)]
    tool: Option<ToolStep>,
    /// Emit a `plan` update with the complete entry list.
    #[serde(default)]
    plan: Option<Vec<PlanEntryScript>>,
}

#[derive(Debug, Deserialize)]
struct ToolStep {
    id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    status: Option<String>,
    /// Each string becomes a `{"type":"text","text":...}` content block.
    #[serde(default)]
    content: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct PlanEntryScript {
    /// Accepted for script readability only: the wire `PlanEntry` has no `id`
    /// field in the current v1 schema, so this is never emitted.
    #[serde(default)]
    #[allow(dead_code)]
    id: Option<String>,
    content: String,
    /// `high` | `medium` | `low`; defaults to `medium` (spec requires the
    /// field on the wire).
    #[serde(default)]
    priority: Option<String>,
    status: String,
}

/// Loads and validates the YAML script at `script_path`.
fn load_script(script_path: &Path) -> Result<Script, String> {
    let raw = std::fs::read_to_string(script_path)
        .map_err(|e| format!("cannot read script {}: {e}", script_path.display()))?;
    let script: Script = serde_yaml::from_str(&raw)
        .map_err(|e| format!("invalid script {}: {e}", script_path.display()))?;
    if !STOP_REASONS.contains(&script.stop.as_str()) {
        return Err(format!(
            "invalid stop {:?}: expected one of {:?}",
            script.stop, STOP_REASONS
        ));
    }
    for step in &script.steps {
        if let Some(tool) = &step.tool
            && let Some(status) = &tool.status
            && !TOOL_CALL_STATUSES.contains(&status.as_str())
        {
            return Err(format!(
                "invalid tool status {status:?} for tool {}: expected one of {TOOL_CALL_STATUSES:?}",
                tool.id
            ));
        }
        if let Some(entries) = &step.plan {
            for entry in entries {
                if !PLAN_ENTRY_STATUSES.contains(&entry.status.as_str()) {
                    return Err(format!(
                        "invalid plan entry status {:?}: expected one of {PLAN_ENTRY_STATUSES:?}",
                        entry.status
                    ));
                }
                if let Some(priority) = &entry.priority
                    && !PLAN_ENTRY_PRIORITIES.contains(&priority.as_str())
                {
                    return Err(format!(
                        "invalid plan entry priority {priority:?}: expected one of {PLAN_ENTRY_PRIORITIES:?}"
                    ));
                }
            }
        }
    }
    Ok(script)
}

/// Runs the mock agent until stdin EOF (returns 0) or a `crash_after`
/// injection fires (returns 3). Startup errors return 2.
pub fn serve(script_path: &Path) -> i32 {
    let script = match load_script(script_path) {
        Ok(script) => script,
        Err(msg) => {
            eprintln!("flowscope-mock-agent: {msg}");
            return STARTUP_EXIT_CODE;
        }
    };

    for line in &script.stderr_lines {
        eprintln!("{line}");
    }

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else {
            break; // read error: treat like EOF
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Malformed JSON lines are skipped, never fatal.
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let id = message.get("id").cloned();
        let params = message.get("params");

        match method {
            "initialize" => {
                if let Some(id) = id {
                    respond(
                        id,
                        json!({
                            "protocolVersion": 1,
                            "agentCapabilities": { "loadSession": false },
                            "authMethods": [],
                        }),
                    );
                }
            }
            "session/new" => {
                if let Some(id) = id {
                    respond(id, json!({ "sessionId": SESSION_ID }));
                }
            }
            "session/prompt" => {
                let session_id = params
                    .and_then(|p| p.get("sessionId"))
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(SESSION_ID);
                if let Some(code) = run_prompt(&script, session_id) {
                    return code;
                }
                if let Some(id) = id {
                    respond(id, json!({ "stopReason": script.stop }));
                }
            }
            // Requests only arrive on stdin in tests poking the mock; the mock
            // never initiates client callbacks itself.
            _ => {
                if let Some(id) = id {
                    respond_error(id, -32601, "Method not found");
                }
            }
        }
    }
    0
}

/// Streams the scripted `session/update` notifications for one prompt turn.
/// Returns `Some(CRASH_EXIT_CODE)` when the `crash_after` injection fires
/// (before the prompt request is answered).
fn run_prompt(script: &Script, session_id: &str) -> Option<i32> {
    let mut seen_tools: HashSet<String> = HashSet::new();
    for (index, step) in script.steps.iter().enumerate() {
        if let Some(delay_ms) = step.delay_ms {
            thread::sleep(Duration::from_millis(delay_ms));
        }
        if let Some(text) = &step.message {
            session_update(
                session_id,
                json!({
                    "sessionUpdate": "agent_message_chunk",
                    "content": text_block(text),
                }),
            );
        }
        if let Some(tool) = &step.tool {
            session_update(session_id, tool_update(tool, &mut seen_tools));
        }
        if let Some(entries) = &step.plan {
            let wire_entries: Vec<Value> = entries
                .iter()
                .map(|entry| {
                    json!({
                        "content": entry.content,
                        "priority": entry.priority.as_deref().unwrap_or("medium"),
                        "status": entry.status,
                    })
                })
                .collect();
            session_update(
                session_id,
                json!({
                    "sessionUpdate": "plan",
                    "entries": wire_entries,
                }),
            );
        }
        if script.crash_after == Some(index + 1) {
            eprintln!(
                "flowscope-mock-agent: crash_after reached after step {}",
                index + 1
            );
            return Some(CRASH_EXIT_CODE);
        }
    }
    if let Some(text) = &script.final_message {
        session_update(
            session_id,
            json!({
                "sessionUpdate": "agent_message_chunk",
                "content": text_block(text),
            }),
        );
    }
    None
}

/// Builds a `tool_call` for the first sight of an id, `tool_call_update` after.
fn tool_update(tool: &ToolStep, seen_tools: &mut HashSet<String>) -> Value {
    let mut update = if seen_tools.insert(tool.id.clone()) {
        json!({
            "sessionUpdate": "tool_call",
            "toolCallId": tool.id,
            // `title` is required on `tool_call`; fall back to the id.
            "title": tool.title.clone().unwrap_or_else(|| tool.id.clone()),
        })
    } else {
        json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": tool.id,
        })
    };
    if let Some(title) = &tool.title {
        update["title"] = json!(title);
    }
    if let Some(kind) = &tool.kind {
        update["kind"] = json!(kind);
    }
    if let Some(status) = &tool.status {
        update["status"] = json!(status);
    }
    if let Some(content) = &tool.content {
        // Tool-call content uses the ToolCallContent envelope: each item is
        // `{"type": "content", "content": <ContentBlock>}` (an unenveloped
        // content block is not valid per the v1 schema and would be dropped
        // by lenient parsers).
        update["content"] = json!(
            content
                .iter()
                .map(|text| json!({"type": "content", "content": text_block(text)}))
                .collect::<Vec<_>>()
        );
    }
    update
}

fn text_block(text: &str) -> Value {
    json!({ "type": "text", "text": text })
}

fn session_update(session_id: &str, update: Value) {
    notify(
        "session/update",
        json!({
            "sessionId": session_id,
            "update": update,
        }),
    );
}

fn respond(id: Value, result: Value) {
    send(json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    }));
}

fn respond_error(id: Value, code: i64, message: &str) {
    send(json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    }));
}

fn notify(method: &str, params: Value) {
    send(json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    }));
}

/// Writes one compact JSON line to stdout and flushes immediately.
fn send(message: Value) {
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{message}");
    let _ = stdout.flush();
}
