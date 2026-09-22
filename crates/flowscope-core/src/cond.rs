use serde_json::Value;
use thiserror::Error;

/// 条件边表达式 AST：相等 / 包含 / 与。
#[derive(Debug, Clone, PartialEq)]
pub enum Cond {
    Eq { path: String, value: Value },
    Contains { path: String, value: String },
    And(Box<Cond>, Box<Cond>),
}

#[derive(Error, Debug)]
#[error("cond: {0}")]
pub struct CondError(pub String);

/// 解析表达式：`"output.a.b == true|1|\"s\""`、`"output.a contains \"x\""`，
/// 多个子式用 `" and "` 连接（左结合折叠为嵌套 `And`）。
pub fn parse(expr: &str) -> Result<Cond, CondError> {
    let parts: Vec<&str> = expr.split(" and ").collect();
    let mut conds: Vec<Cond> = Vec::with_capacity(parts.len());
    for p in parts {
        conds.push(parse_atom(p)?);
    }
    conds
        .into_iter()
        .reduce(|acc, c| Cond::And(Box::new(acc), Box::new(c)))
        .ok_or_else(|| CondError("空表达式".into()))
}

fn parse_atom(s: &str) -> Result<Cond, CondError> {
    let s = s.trim();
    if let Some((path, lit)) = s.split_once(" == ") {
        return Ok(Cond::Eq {
            path: parse_path(path)?,
            value: parse_literal(lit.trim())?,
        });
    }
    if let Some((path, lit)) = s.split_once(" contains ") {
        let value = match parse_literal(lit.trim())? {
            Value::String(v) => v,
            other => return Err(CondError(format!("contains 仅支持字符串字面量: {other}"))),
        };
        return Ok(Cond::Contains {
            path: parse_path(path)?,
            value,
        });
    }
    Err(CondError(format!(
        "无法解析条件（仅支持 == / contains）: {s}"
    )))
}

/// 路径必须以 `output.` 开头且剩余部分非空（解析期校验）。
fn parse_path(path: &str) -> Result<String, CondError> {
    let path = path.trim();
    match path.strip_prefix("output.") {
        Some(rest) if !rest.is_empty() => Ok(path.to_string()),
        _ => Err(CondError(format!("路径必须以 output. 开头: {path}"))),
    }
}

/// 字面量：`true` / `false` / 整数（i64）/ 双引号字符串（内容原样，不处理转义）。
fn parse_literal(s: &str) -> Result<Value, CondError> {
    match s {
        "true" => return Ok(Value::Bool(true)),
        "false" => return Ok(Value::Bool(false)),
        _ => {}
    }
    if let Ok(n) = s.parse::<i64>() {
        return Ok(Value::from(n));
    }
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        return Ok(Value::String(s[1..s.len() - 1].to_string()));
    }
    Err(CondError(format!("无法解析字面量: {s}")))
}

/// 求值：路径去掉 `output.` 前缀后按 `.` 逐层取值；路径缺失一律为 false（不报错）。
pub fn eval(cond: &Cond, output: &Value) -> bool {
    match cond {
        Cond::Eq { path, value } => lookup(output, path).is_some_and(|v| v == value),
        Cond::Contains { path, value } => lookup(output, path)
            .is_some_and(|v| v.as_str().is_some_and(|s| s.contains(value.as_str()))),
        Cond::And(a, b) => eval(a, output) && eval(b, output),
    }
}

fn lookup<'a>(output: &'a Value, path: &str) -> Option<&'a Value> {
    let rel = path.strip_prefix("output.")?;
    let mut cur = output;
    for seg in rel.split('.') {
        cur = cur.get(seg)?;
    }
    Some(cur)
}

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
