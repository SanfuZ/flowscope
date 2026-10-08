use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use thiserror::Error;

/// 工作流定义（解析自 YAML，`meta.name`/`meta.version` 已提升到顶层字段）。
#[derive(Debug, Clone)]
pub struct WorkflowDef {
    pub name: String,
    pub version: u32,
    pub params: serde_json::Map<String, serde_json::Value>,
    pub nodes: Vec<AgentNodeDef>,
    pub edges: Vec<EdgeDef>,
    /// 节点失败策略：`"abort_run"`（默认，None 同义）或 `"continue_independent"`。
    pub on_node_failure: Option<String>,
    /// `meta.tags` 分类标记（可选）：不进引擎语义（编排忽略），仅供 fs API
    /// 与「保存到文件夹」的文档保真（文件夹页按首个 tag 分组展示）。
    pub tags: Option<Vec<String>>,
}

/// 单个节点定义。
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentNodeDef {
    pub id: String,
    pub agent: String,
    pub prompt: String,
    #[serde(default)]
    pub output_schema: Option<serde_json::Value>,
    #[serde(default)]
    pub retry: RetryDef,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// 重试策略，默认 `max=0, backoff_ms=1000`。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetryDef {
    #[serde(default)]
    pub max: u32,
    #[serde(default = "default_backoff_ms")]
    pub backoff_ms: u64,
}

impl Default for RetryDef {
    fn default() -> Self {
        Self {
            max: 0,
            backoff_ms: 1000,
        }
    }
}

fn default_backoff_ms() -> u64 {
    1000
}

/// 边定义，`when` 为条件表达式（可选）。
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EdgeDef {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub when: Option<String>,
}

/// YAML 文档的线格式：`meta` 单独一层，便于对顶层使用 `deny_unknown_fields`。
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawWorkflow {
    meta: RawMeta,
    #[serde(default)]
    params: serde_json::Map<String, serde_json::Value>,
    nodes: Vec<AgentNodeDef>,
    #[serde(default)]
    edges: Vec<EdgeDef>,
    #[serde(default)]
    on_node_failure: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawMeta {
    name: String,
    version: u32,
    /// 分类标记（可选）：字符串数组；缺省 None（与空数组区分，序列化保真）。
    #[serde(default)]
    tags: Option<Vec<String>>,
}

#[derive(Error, Debug)]
pub enum WorkflowError {
    #[error("yaml: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("{0}")]
    Invalid(String),
}

/// 反序列化 YAML 文本为 `WorkflowDef`，拒绝未知字段。
pub fn parse_yaml(yaml: &str) -> Result<WorkflowDef, WorkflowError> {
    let raw: RawWorkflow = serde_yaml::from_str(yaml)?;
    Ok(WorkflowDef {
        name: raw.meta.name,
        version: raw.meta.version,
        params: raw.params,
        nodes: raw.nodes,
        edges: raw.edges,
        on_node_failure: raw.on_node_failure,
        tags: raw.meta.tags,
    })
}

/// 结构校验：节点 id 唯一、边引用存在、Kahn 判无环。
pub fn validate(wf: &WorkflowDef) -> Result<(), WorkflowError> {
    let mut ids = HashSet::new();
    for n in &wf.nodes {
        if !ids.insert(n.id.as_str()) {
            return Err(WorkflowError::Invalid(format!("重复节点 id: {}", n.id)));
        }
    }
    let node_ids: HashSet<&str> = ids.iter().copied().collect();
    for e in &wf.edges {
        if !node_ids.contains(e.from.as_str()) || !node_ids.contains(e.to.as_str()) {
            return Err(WorkflowError::Invalid(format!(
                "边引用不存在的节点: {} -> {}",
                e.from, e.to
            )));
        }
    }
    // Kahn：入度表 + 队列；处理数 < 节点数 => 有环
    let mut indeg: HashMap<&str, usize> = wf.nodes.iter().map(|n| (n.id.as_str(), 0)).collect();
    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
    for e in &wf.edges {
        adj.entry(e.from.as_str()).or_default().push(e.to.as_str());
        indeg.entry(e.to.as_str()).and_modify(|d| *d += 1);
    }
    let mut queue: Vec<&str> = indeg
        .iter()
        .filter(|(_, d)| **d == 0)
        .map(|(k, _)| *k)
        .collect();
    let mut seen = 0;
    while let Some(n) = queue.pop() {
        seen += 1;
        for &m in adj.get(n).into_iter().flatten() {
            let d = indeg.get_mut(m).unwrap();
            *d -= 1;
            if *d == 0 {
                queue.push(m);
            }
        }
    }
    if seen != wf.nodes.len() {
        return Err(WorkflowError::Invalid("工作流存在环".into()));
    }
    Ok(())
}

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
        let cyc = VALID.replace("from: analyze, to: report", "from: analyze, to: collect");
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

    /// meta.tags（可选）：给出时提升为 Vec<String>；缺省为 None（与空数组区分）。
    #[test]
    fn lifts_meta_tags() {
        let with_tags = VALID.replace(
            "meta: {name: demo, version: 3}",
            "meta: {name: demo, version: 3, tags: [演示, alpha]}",
        );
        let wf = parse_yaml(&with_tags).unwrap();
        assert_eq!(wf.tags, Some(vec!["演示".to_owned(), "alpha".to_owned()]));
        // 缺省 None
        let wf = parse_yaml(VALID).unwrap();
        assert_eq!(wf.tags, None);
        // tags 非字符串数组 → 解析失败（serde 类型错误）
        let bad = VALID.replace(
            "meta: {name: demo, version: 3}",
            "meta: {name: demo, version: 3, tags: 演示}",
        );
        assert!(parse_yaml(&bad).is_err());
    }
}
