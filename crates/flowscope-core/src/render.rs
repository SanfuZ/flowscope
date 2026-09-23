use minijinja::{Environment, UndefinedBehavior};
use serde_json::Value;
use std::collections::HashMap;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum RenderError {
    #[error("template: {0}")]
    Template(String),
    #[error("extraction: {0}")]
    Extraction(String),
}

/// 用 minijinja 渲染提示词模板，上下文暴露 `params` 与 `nodes`
/// （nodes 为各节点完整输出对象，模板经 `nodes.<id>.output.text` 取值）。
/// 未定义变量按 Strict 处理（引用缺失直接报模板错误，而非静默渲染为空）。
pub fn render_prompt(
    template: &str,
    params: &Value,
    node_outputs: &HashMap<String, Value>,
) -> Result<String, RenderError> {
    let mut env = Environment::empty();
    env.set_undefined_behavior(UndefinedBehavior::Strict);
    let ctx = serde_json::json!({"params": params, "nodes": node_outputs});
    env.render_named_str("prompt", template, &ctx)
        .map_err(|e| RenderError::Template(e.to_string()))
}

/// 从最后一条消息提取结构化输出：
/// 无 schema → `{"text": last_message}`；有 schema → 截取首个 '{' 到末个 '}' 解析 JSON 并校验；
/// 无合法 JSON 或校验失败 → Err（引擎将其转为 node.failed(extraction)）。
pub fn extract_output(last_message: &str, schema: Option<&Value>) -> Result<Value, RenderError> {
    let Some(schema) = schema else {
        return Ok(serde_json::json!({"text": last_message}));
    };
    // 首个 '{' 到末个 '}' 之间的子串；缺失或顺序颠倒（'}' 在 '{' 之前）均视为无 JSON。
    let candidate = match (last_message.find('{'), last_message.rfind('}')) {
        (Some(start), Some(end)) if end > start => &last_message[start..=end],
        _ => return Err(RenderError::Extraction("消息中未找到 JSON 对象".into())),
    };
    let value: Value = serde_json::from_str(candidate)
        .map_err(|e| RenderError::Extraction(format!("JSON 解析失败: {e}")))?;
    let validator = jsonschema::validator_for(schema)
        .map_err(|e| RenderError::Extraction(format!("schema 无效: {e}")))?;
    validator
        .validate(&value)
        .map_err(|e| RenderError::Extraction(format!("schema 校验失败: {e}")))?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn renders_params_and_node_outputs() {
        let out = render_prompt(
            "分析 {{ params.week }} / {{ nodes.a.output.text }}",
            &json!({"week": "W38"}),
            &[("a".to_string(), json!({"output": {"text": "数据x"}}))].into(),
        )
        .unwrap();
        assert_eq!(out, "分析 W38 / 数据x");
    }

    #[test]
    fn extracts_structured_or_wraps_text() {
        let schema =
            json!({"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}});
        let v = extract_output(r#"前缀 {"ok": true} 后缀"#, Some(&schema)).unwrap();
        assert_eq!(v["ok"], true);
        let v = extract_output("纯文本", None).unwrap();
        assert_eq!(v["text"], "纯文本");
        assert!(extract_output("没有json", Some(&schema)).is_err());
        assert!(extract_output(r#"{"ok": "yes"}"#, Some(&schema)).is_err()); // 类型不符
    }
}
