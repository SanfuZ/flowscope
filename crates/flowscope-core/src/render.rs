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
/// （nodes 为各节点完整输出对象，模板经 `nodes.<id>.output.<path>` 取值）。
/// 渲染前经 [`preprocess_non_ascii_attributes`] 预处理：含非 ASCII（中文节点
/// ID/参数名）或连字符等非法标识符字符的点访问自动转为下标形式，中文 ID 可直接
/// 写点语法。未定义变量按 Strict 处理（引用缺失直接报模板错误，而非静默渲染为空）。
pub fn render_prompt(
    template: &str,
    params: &Value,
    node_outputs: &HashMap<String, Value>,
) -> Result<String, RenderError> {
    let mut env = Environment::empty();
    env.set_undefined_behavior(UndefinedBehavior::Strict);
    let ctx = serde_json::json!({"params": params, "nodes": node_outputs});
    let template = preprocess_non_ascii_attributes(template);
    env.render_named_str("prompt", &template, &ctx)
        .map_err(|e| RenderError::Template(e.to_string()))
}

/// 判断 `seg` 是否为合法 minijinja 标识符（`[A-Za-z_][A-Za-z0-9_]*`）。
fn is_minijinja_ident(seg: &str) -> bool {
    let mut cs = seg.chars();
    matches!(cs.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && cs.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 属性段内的合法字符：字母数字（含非 ASCII）、下划线、连字符。
/// 其余（空白、引号、各类标点符号）一律终止段——保证改写结果是单个安全的字符串字面量。
fn is_seg_char(c: char) -> bool {
    c == '_' || c == '-' || c.is_alphanumeric()
}

/// 路径回溯字符：段字符加 `.`（跨段回溯到表达式边界，用于定位路径首段）。
fn is_path_char(c: char) -> bool {
    is_seg_char(c) || c == '.'
}

/// 将模板表达式中含非标识符字符（中文节点 ID/参数名、连字符 id 等）的点访问段
/// 改写为等价的下标形式：`{{ nodes.取数.output.数据 }}` →
/// `{{ nodes["取数"].output["数据"] }}`。
///
/// 背景：minijinja 的点语法只接受 ASCII 标识符，非 ASCII 字符在解析期直接报
/// `unexpected character`；下标 `["任意文本"]` 语义等价且合法，故只做形式改写、
/// 不改取值语义。纯函数：不触发改写时输出与输入逐字节一致（ASCII 模板零影响）。
///
/// 规则（只在 `{{ }}`/`{% %}` 表达式内生效；普通文本与 `{# #}` 注释原样保留）：
/// - `.` 后的属性段（字母数字/`_`/`-` 连续串）若非合法标识符且非纯数字
///   （纯数字跳过以保护 `1.5` 浮点字面量与既有 `list.0` 索引写法），改写为 `["段"]`；
/// - 路径首段（base）本身非合法标识符时（如 `{{ my-id.x }}` 的 `my-id`），
///   其后的点访问段一并改写为下标；
/// - 引号字符串（含 `\"` 转义）与既有 `["..."]` 写法内部原样保留。
pub fn preprocess_non_ascii_attributes(template: &str) -> String {
    let chars: Vec<char> = template.chars().collect();
    let mut out = String::with_capacity(template.len());
    let mut i = 0;
    let mut in_expr = false; // 位于 {{ }} / {% %} 表达式内
    let mut in_comment = false; // 位于 {# #} 注释内
    let mut quote: Option<char> = None; // 表达式内引号状态
    while i < chars.len() {
        let c = chars[i];
        if in_comment {
            out.push(c);
            if c == '#' && chars.get(i + 1) == Some(&'}') {
                out.push('}');
                in_comment = false;
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }
        if let Some(q) = quote {
            out.push(c);
            if c == '\\' && i + 1 < chars.len() {
                out.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        if !in_expr {
            out.push(c);
            if c == '{' && matches!(chars.get(i + 1), Some('{') | Some('%')) {
                out.push(chars[i + 1]);
                in_expr = true;
                i += 2;
            } else if c == '{' && chars.get(i + 1) == Some(&'#') {
                out.push('#');
                in_comment = true;
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }
        // 表达式内
        match c {
            '"' | '\'' => {
                quote = Some(c);
                out.push(c);
                i += 1;
            }
            '}' if chars.get(i + 1) == Some(&'}') => {
                out.push_str("}}");
                in_expr = false;
                i += 2;
            }
            '%' if chars.get(i + 1) == Some(&'}') => {
                out.push_str("%}");
                in_expr = false;
                i += 2;
            }
            '.' => {
                // 收集 `.` 后的属性段（到边界字符为止）
                let start = i + 1;
                let mut end = start;
                while end < chars.len() && is_seg_char(chars[end]) {
                    end += 1;
                }
                if end == start {
                    out.push('.');
                    i += 1;
                    continue;
                }
                let seg: String = chars[start..end].iter().collect();
                // 回溯路径前缀，取首个段为 base（`{{ my-id.x }}` 的 `my-id`）
                let mut b = i;
                while b > 0 && is_path_char(chars[b - 1]) {
                    b -= 1;
                }
                let pre = chars[b..i].iter().collect::<String>();
                let base = pre.split('.').next().unwrap_or("");
                let numeric = seg.chars().all(|c| c.is_ascii_digit());
                // base 同样跳过纯数字（`{{ 1.5 }}` 是浮点字面量，不是路径）
                let base_literal = !base.is_empty() && base.chars().all(|c| c.is_ascii_digit());
                let needs_rewrite = (!numeric && !is_minijinja_ident(&seg))
                    || (!base.is_empty() && !base_literal && !is_minijinja_ident(base));
                if needs_rewrite {
                    out.push_str("[\"");
                    out.push_str(&seg);
                    out.push_str("\"]");
                } else {
                    out.push('.');
                    out.push_str(&seg);
                }
                i = end;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// 从最后一条消息提取结构化输出：
/// 无 schema → `{"text": last_message}`；有 schema → 候选扫描提取，按优先序生成候选，
/// 首个「可解析且通过 schema 校验」者胜出：
/// ① 整条消息 trim；② ```json / ``` 围栏块内文（逐个）；③ 末位平衡 JSON 对象扫描
/// （从右向左逐个 '{' 作起点做字符串感知的括号配对）——右边的候选先产生，天然优先
/// 最终答案 JSON 而非思考文本中回显的模板 JSON（旧「首 '{' 到末 '}'」切片法会被其污染）。
/// 仅支持对象（数组不作为候选）。全部候选失败 → Err（附消息长度与尾部 200 字符诊断；
/// 引擎将其转为 node.failed(extraction)）。
pub fn extract_output(last_message: &str, schema: Option<&Value>) -> Result<Value, RenderError> {
    let Some(schema) = schema else {
        return Ok(serde_json::json!({"text": last_message}));
    };
    let validator = jsonschema::validator_for(schema)
        .map_err(|e| RenderError::Extraction(format!("schema 无效: {e}")))?;

    let mut candidates: Vec<&str> = vec![last_message.trim()];
    candidates.extend(fenced_json_blocks(last_message));
    candidates.extend(balanced_objects_from_end(last_message));

    for candidate in candidates {
        let Ok(value) = serde_json::from_str::<Value>(candidate) else {
            continue;
        };
        if validator.validate(&value).is_ok() {
            return Ok(value);
        }
    }

    // 有界诊断：消息总长 + 尾部 200 字符（换行转义，保证单行可读）。
    let char_count = last_message.chars().count();
    let tail: String = last_message
        .chars()
        .skip(char_count.saturating_sub(200))
        .collect();
    let tail = tail.replace('\n', "\\n").replace('\r', "\\r");
    Err(RenderError::Extraction(format!(
        "消息中未找到可解析的 JSON 对象（消息长度 {char_count}，尾部 200 字符: {tail}）"
    )))
}

/// 收集消息中所有围栏代码块（```json …``` / ``` …```）的内文切片。
/// ``` 后至行尾的非空字母数字串视为语言标记行，整行跳过；内文到下一个 ``` 为止
/// （无闭合围栏则放弃该块）。切片引用原消息，零拷贝。
fn fenced_json_blocks(message: &str) -> Vec<&str> {
    let mut blocks = Vec::new();
    let mut i = 0;
    while let Some(rel) = message[i..].find("```") {
        let after = i + rel + 3;
        let body_start = match message[after..].find('\n') {
            Some(nl) => {
                let tag = message[after..after + nl].trim();
                if !tag.is_empty() && tag.chars().all(|c| c.is_ascii_alphanumeric()) {
                    after + nl + 1
                } else {
                    after
                }
            }
            None => after,
        };
        match message[body_start..].find("```") {
            Some(close_rel) => {
                blocks.push(&message[body_start..body_start + close_rel]);
                i = body_start + close_rel + 3;
            }
            None => break,
        }
    }
    blocks
}

/// 末位平衡 JSON 对象扫描：从消息末尾向左逐个 '{' 作起点，前向做字符串感知的
/// 括号配对到其匹配 '}'，得到候选切片（右先左后 → 最终答案 JSON 排在思考回显之前）。
fn balanced_objects_from_end(message: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let bytes = message.as_bytes();
    let mut pos = message.len();
    while let Some(start) = message[..pos].rfind('{') {
        if let Some(end) = match_object(bytes, start) {
            out.push(&message[start..=end]);
        }
        pos = start;
    }
    out
}

/// 从 `start`（指向 '{'）做括号配对，返回匹配 '}' 的字节下标；无匹配（不闭合）→ None。
/// 引号字符串内的 '{'/'}' 不参与计数，转义序列（`\"`、`\\` 等）不终止字符串。
fn match_object(bytes: &[u8], start: usize) -> Option<usize> {
    debug_assert_eq!(bytes[start], b'{');
    let mut depth = 0usize;
    let mut in_string = false;
    let mut i = start;
    while i < bytes.len() {
        match bytes[i] {
            b'"' if in_string => in_string = false,
            b'"' => in_string = true,
            b'\\' if in_string => i += 1, // 跳过转义后的字符
            b'{' if !in_string => depth += 1,
            b'}' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
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

    // ---------- 非 ASCII 点访问预处理（bug 回归锁） ----------

    #[test]
    fn preprocess_converts_non_ascii_dot_access() {
        // 中文点访问 → 下标（本 bug 的核心场景）
        assert_eq!(
            preprocess_non_ascii_attributes("{{ nodes.取数.output.数据 }}"),
            "{{ nodes[\"取数\"].output[\"数据\"] }}"
        );
        assert_eq!(
            preprocess_non_ascii_attributes("{{ params.主题 }}"),
            "{{ params[\"主题\"] }}"
        );
    }

    #[test]
    fn preprocess_leaves_ascii_numeric_and_bracket_alone() {
        // 纯 ASCII 点访问逐字节不变
        assert_eq!(
            preprocess_non_ascii_attributes("{{ nodes.a.output.text }}"),
            "{{ nodes.a.output.text }}"
        );
        // 数字结尾的合法标识符不动
        assert_eq!(
            preprocess_non_ascii_attributes("{{ loop.index0 }}"),
            "{{ loop.index0 }}"
        );
        // 纯数字段不动（保护浮点字面量与 list.0 写法）
        assert_eq!(preprocess_non_ascii_attributes("{{ 1.5 }}"), "{{ 1.5 }}");
        // 既有下标写法原样保留
        assert_eq!(
            preprocess_non_ascii_attributes("{{ params[\"主题\"].output }}"),
            "{{ params[\"主题\"].output }}"
        );
    }

    #[test]
    fn preprocess_skips_quoted_strings_and_plain_text() {
        // 引号字符串内的点/非 ASCII 原样保留
        assert_eq!(
            preprocess_non_ascii_attributes("{{ \"a.主题\" }}{{ 'b.c' }}"),
            "{{ \"a.主题\" }}{{ 'b.c' }}"
        );
        // 表达式外的普通文本与 {# 注释 #} 一律不动
        assert_eq!(
            preprocess_non_ascii_attributes(
                "见 config.配置 与 v1.2 说明 {{ params.x }} 尾部.nodes {# 注.释 #}"
            ),
            "见 config.配置 与 v1.2 说明 {{ params.x }} 尾部.nodes {# 注.释 #}"
        );
        // 过滤器管道与块语法不受影响
        assert_eq!(
            preprocess_non_ascii_attributes(
                "{% if params.主题 == \"x\" %}{{ params.主题 | upper }}{% endif %}"
            ),
            "{% if params[\"主题\"] == \"x\" %}{{ params[\"主题\"] | upper }}{% endif %}"
        );
    }

    #[test]
    fn preprocess_converts_hyphen_segments() {
        // 连字符不是合法标识符字符：属性段中的连字符触发下标改写
        assert_eq!(
            preprocess_non_ascii_attributes("{{ nodes.my-id.x }}"),
            "{{ nodes[\"my-id\"].x }}"
        );
        // 路径首段（base）含连字符时，其后的点访问段也改写为下标
        assert_eq!(
            preprocess_non_ascii_attributes("{{ my-id.x }}"),
            "{{ my-id[\"x\"] }}"
        );
    }

    #[test]
    fn render_prompt_accepts_non_ascii_dot_access() {
        // 端到端：修复前该模板报 "unexpected character" → node.failed
        let out = render_prompt(
            "主题 {{ params.主题 }} / 取数 {{ nodes.取数.output.数据 }}",
            &json!({"主题": "周报"}),
            &[("取数".to_string(), json!({"output": {"数据": "42 行"}}))].into(),
        )
        .unwrap();
        assert_eq!(out, "主题 周报 / 取数 42 行");
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

    // ---------- 结构化提取候选扫描（末位平衡 JSON/围栏） ----------

    #[test]
    fn extraction_prefers_last_object_over_thinking_echo() {
        // 思考文本回显模板 JSON（旧「首 '{' 到末 '}'」切片会横跨两个对象解析失败）
        let schema = json!({"type":"object","required":["ok","数据"],"properties":{
            "ok":{"type":"boolean"},"数据":{"type":"string"}}});
        let msg = "思考：模板 {\"ok\": true, \"数据\": \"<占位>\"} \n\n正文：{\"ok\": true, \"数据\": \"3条数据\"}";
        let v = extract_output(msg, Some(&schema)).unwrap();
        assert_eq!(v["数据"], "3条数据");
    }

    #[test]
    fn extraction_accepts_fenced_json_block() {
        let schema =
            json!({"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}});
        // 带语言标记的围栏
        let v = extract_output(
            "结果如下：\n```json\n{\"ok\": true}\n```\n以上。",
            Some(&schema),
        )
        .unwrap();
        assert_eq!(v["ok"], true);
        // 无语言标记的围栏
        let v = extract_output("```\n{\"ok\": false}\n```", Some(&schema)).unwrap();
        assert_eq!(v["ok"], false);
    }

    #[test]
    fn extraction_error_includes_bounded_diagnostics() {
        let schema =
            json!({"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}});
        let err = extract_output("纯文本没有大括号", Some(&schema))
            .unwrap_err()
            .to_string();
        assert!(err.contains("消息长度"), "缺少诊断: {err}");
        assert!(err.contains("尾部 200 字符"));
    }

    #[test]
    fn extraction_rejects_unbalanced_braces() {
        let schema =
            json!({"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}});
        assert!(extract_output("{\"ok\": true", Some(&schema)).is_err());
        assert!(extract_output("{\"ok\": true,\"嵌套\": {\"a\": 1}", Some(&schema)).is_err());
    }

    #[test]
    fn extraction_tolerates_braces_in_strings_and_trailing_text() {
        let schema = json!({"type":"object","required":["ok"],"properties":{
            "ok":{"type":"boolean"},"备注":{"type":"string"}}});
        // 字符串内的大括号不参与配对；对象后仍有尾随文本
        let msg = r#"答案 {"ok": true, "备注": "花括号 } { 不影响"} 附注：完成。"#;
        let v = extract_output(msg, Some(&schema)).unwrap();
        assert_eq!(v["备注"], "花括号 } { 不影响");
        // 对象后多余的 '}'（右向左扫描仍从正确的 '{' 配对出完整对象）
        let v = extract_output(r#"{"ok": true}}"#, Some(&schema)).unwrap();
        assert_eq!(v["ok"], true);
    }
}
