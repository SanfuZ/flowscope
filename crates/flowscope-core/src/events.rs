use std::sync::Arc;

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

// ---------------------------------------------------------------------------
// 脱敏（spec §8，M1 纯函数形态）
// ---------------------------------------------------------------------------

/// 一条脱敏规则：`pattern` 为正则（`regex` crate 语法），匹配到的子串全部
/// 替换为 `replacement`。`Arc<str>` 便于规则表跨句柄廉价共享（M2 接线用）。
#[derive(Debug, Clone)]
pub struct RedactRule {
    pub pattern: Arc<str>,
    pub replacement: String,
}

/// 纯函数脱敏：递归遍历 JSON 对象/数组，对每个**字符串值**按传入顺序依次
/// 应用全部规则（`replace_all`）；数字/布尔/null 等原样保留，键名不改。
/// 非法正则的规则直接跳过（不 panic）。返回新值，不修改入参。
///
/// M1 交付形态：每次调用内部编译正则（事件量小、调用方为低频路径，可
/// 接受）；config 规则加载与事件管道接线为 M2，届时再考虑预编译缓存。
pub fn redact(payload: &serde_json::Value, rules: &[RedactRule]) -> serde_json::Value {
    // 每次调用编译一次（M1 形态，见函数文档）；非法正则直接过滤掉
    let compiled: Vec<(regex::Regex, &str)> = rules
        .iter()
        .filter_map(|r| {
            regex::Regex::new(&r.pattern)
                .ok()
                .map(|re| (re, r.replacement.as_str()))
        })
        .collect();
    redact_value(payload, &compiled)
}

/// 递归核心：只改写 JSON 字符串值，键名与非字符串叶子原样克隆。
fn redact_value(v: &serde_json::Value, rules: &[(regex::Regex, &str)]) -> serde_json::Value {
    match v {
        serde_json::Value::String(s) => {
            let mut out = s.clone();
            for (re, replacement) in rules {
                out = re.replace_all(&out, *replacement).into_owned();
            }
            serde_json::Value::String(out)
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(|i| redact_value(i, rules)).collect())
        }
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.iter()
                .map(|(k, val)| (k.clone(), redact_value(val, rules)))
                .collect(),
        ),
        other => other.clone(),
    }
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

    // ---- redact 纯函数（spec §8，M1 交付形态）----

    use super::{RedactRule, redact};

    fn rule(pattern: &str, replacement: &str) -> RedactRule {
        RedactRule {
            pattern: Arc::from(pattern),
            replacement: replacement.to_owned(),
        }
    }

    #[test]
    fn redact_replaces_strings_nested_in_objects_and_arrays() {
        let payload = serde_json::json!({
            "prompt": "token sk-abc123 请处理",
            "steps": [
                {"detail": "key sk-abc123 again"},
                "bare sk-abc123 string",
                42
            ],
            "count": 7,
            "flag": true,
            "empty": null
        });
        let out = redact(&payload, &[rule(r"sk-[a-z0-9]+", "[REDACTED]")]);
        assert_eq!(out["prompt"], "token [REDACTED] 请处理");
        assert_eq!(out["steps"][0]["detail"], "key [REDACTED] again");
        assert_eq!(out["steps"][1], "bare [REDACTED] string");
        // 同一字符串内多次匹配全部替换（replace_all）
        let multi = serde_json::json!("a sk-aa1 b sk-bb2 c");
        assert_eq!(redact(&multi, &[rule(r"sk-[a-z0-9]+", "X")]), "a X b X c");
        // 数字/布尔/null 原样保留
        assert_eq!(out["steps"][2], 42);
        assert_eq!(out["count"], 7);
        assert_eq!(out["flag"], true);
        assert_eq!(out["empty"], serde_json::Value::Null);
        // 纯函数：入参不被修改
        assert_eq!(payload["prompt"], "token sk-abc123 请处理");
    }

    #[test]
    fn redact_applies_multiple_rules_in_order() {
        let payload = serde_json::json!({"msg": "user bob@corp.com ran key=K9 on host-1"});
        // 先替换邮箱 → 再替换 key=...；顺序不同结果不同，此处验证按序串联
        let out = redact(
            &payload,
            &[
                rule(r"\S+@corp\.com", "<email>"),
                rule(r"key=\w+", "key=<secret>"),
            ],
        );
        assert_eq!(out["msg"], "user <email> ran key=<secret> on host-1");
        // 逆序验证顺序确实生效：key= 规则先跑也不冲突，但邮箱规则后跑仍命中
        let out2 = redact(
            &payload,
            &[
                rule(r"key=\w+", "key=<secret>"),
                rule(r"\S+@corp\.com", "<email>"),
            ],
        );
        assert_eq!(out2["msg"], "user <email> ran key=<secret> on host-1");
        // 顺序可观察的用例：第一条规则的替换产物会被第二条继续处理
        // （"AAA" --A→AB--> "ABABAB" --AB→Z--> "ZZZ"；逆序则两条都不再命中）
        let chained = serde_json::json!({"s": "AAA"});
        let out3 = redact(&chained, &[rule("A", "AB"), rule("AB", "Z")]);
        assert_eq!(out3["s"], "ZZZ");
        let out4 = redact(&chained, &[rule("AB", "Z"), rule("A", "AB")]);
        assert_eq!(out4["s"], "ABABAB");
    }

    #[test]
    fn redact_leaves_numbers_bools_and_null_untouched() {
        let payload = serde_json::json!({
            "n": -3.14,
            "i": 1_000_000,
            "b": false,
            "z": null,
            "arr": [0, true, null],
            "s": "no match here"
        });
        let out = redact(&payload, &[rule(r"sk-[a-z]+", "[R]")]);
        assert_eq!(out, payload);
    }

    #[test]
    fn redact_skips_invalid_regex_without_panic() {
        let payload = serde_json::json!({"secret": "sk-xyz stays"});
        // 非法正则（未闭合分组）→ 跳过该规则不 panic；合法规则仍生效
        let out = redact(
            &payload,
            &[rule("(unclosed", "[BAD]"), rule(r"sk-\w+", "[OK]")],
        );
        assert_eq!(out["secret"], "[OK] stays");
        // 全部非法 → 原样返回
        let out2 = redact(
            &payload,
            &[rule("(unclosed", "[BAD]"), rule("[also", "bad")],
        );
        assert_eq!(out2, payload);
    }

    #[test]
    fn redact_with_empty_rules_returns_equal_value() {
        let payload = serde_json::json!({"a": ["x", 1], "s": "sk-keep"});
        assert_eq!(redact(&payload, &[]), payload);
        // 空字符串值与无字符串的深嵌套同样原样返回
        let deep = serde_json::json!({"l1": {"l2": [{"l3": [[{"leaf": ""}]]}]}});
        assert_eq!(redact(&deep, &[rule("x", "y")]), deep);
    }
}
