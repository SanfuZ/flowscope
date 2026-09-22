use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EventKind {
    #[serde(rename = "run.started")]
    RunStarted,
    #[serde(rename = "run.finished")]
    RunFinished,
    #[serde(rename = "run.failed")]
    RunFailed,
    #[serde(rename = "run.cancelled")]
    RunCancelled,
    #[serde(rename = "run.interrupted")]
    RunInterrupted,
    #[serde(rename = "node.started")]
    NodeStarted,
    #[serde(rename = "node.finished")]
    NodeFinished,
    #[serde(rename = "node.cancelled")]
    NodeCancelled,
    #[serde(rename = "node.failed")]
    NodeFailed,
    #[serde(rename = "node.skipped")]
    NodeSkipped,
    #[serde(rename = "node.retry")]
    NodeRetry,
    #[serde(rename = "msg.delta")]
    MsgDelta,
    #[serde(rename = "tool.update")]
    ToolUpdate,
    #[serde(rename = "plan.snapshot")]
    PlanSnapshot,
    #[serde(rename = "session.meta")]
    SessionMeta,
    #[serde(rename = "log.lines")]
    LogLines,
    #[serde(rename = "callback")]
    Callback,
    #[serde(rename = "permission")]
    Permission,
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

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn kind_serializes_dotted_lowercase() {
        assert_eq!(
            serde_json::to_string(&EventKind::MsgDelta).unwrap(),
            "\"msg.delta\""
        );
        assert_eq!(
            serde_json::to_string(&EventKind::NodeFinished).unwrap(),
            "\"node.finished\""
        );
        assert_eq!(
            serde_json::to_string(&EventKind::RunStarted).unwrap(),
            "\"run.started\""
        );
    }

    #[test]
    fn event_roundtrip() {
        let ev = FsEvent {
            seq: 7,
            ts: chrono::Utc.timestamp_millis_opt(1758500000000).unwrap(),
            run_id: "run_ab12".into(),
            node_id: Some("analyze".into()),
            session_id: Some("sess_1".into()),
            kind: EventKind::ToolUpdate,
            payload: serde_json::json!({"toolCallId": "t1", "status": "in_progress"}),
        };
        let s = serde_json::to_string(&ev).unwrap();
        assert!(s.contains("\"kind\":\"tool.update\""));
        let back: FsEvent = serde_json::from_str(&s).unwrap();
        assert_eq!(back.seq, 7);
        assert_eq!(back.node_id.as_deref(), Some("analyze"));
    }
}
