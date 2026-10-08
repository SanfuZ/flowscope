// 工作流 YAML 的严格解析/序列化（yaml@2 包驱动），与后端 WorkflowDef serde
// 线格式对齐：顶层 {meta, params, on_node_failure, nodes, edges}（后端
// deny_unknown_fields，未知顶层键将被拒绝）。设计取舍（控制器裁定）：
//   - 本模块只做【结构】校验（类型/形状），语义校验（id 唯一/引用/环/when
//     语法）归 lib/validate.ts，两者合起来构成保存门槛；
//   - retry/timeout_ms/output_schema 透传不深校验——后端 serde 权威；
//   - nodes 可缺省/为空（空工作流合法加载），与后端“nodes 必填”不同，
//     这是有意的宽松：加载兜底优先，保存时由 validateWorkflow 把守。
import { isMap, parseDocument, stringify } from 'yaml';

export interface RetryModel {
  max: number;
  backoff_ms: number;
}

export interface NodeModel {
  id: string;
  agent: string;
  prompt: string;
  output_schema?: unknown;
  retry?: RetryModel;
  timeout_ms?: number;
}

export interface EdgeModel {
  from: string;
  to: string;
  when?: string;
}

export interface WorkflowModel {
  name: string;
  version: number;
  /** 分类标记（meta.tags，可选）：不进引擎语义；文件夹页按首个 tag 分组，
   *  「保存到文件夹」时随 YAML 原文写回。空数组序列化时省略（等同未设）。 */
  tags?: string[];
  params: Record<string, string | number | boolean>;
  /** 节点失败策略（透传，不深校验）：`abort_run`（默认，缺省同义）或 `continue_independent`。 */
  on_node_failure?: string;
  nodes: NodeModel[];
  edges: EdgeModel[];
}

/** 严格解析：结构不符返回 { errors }（errors 为中文消息数组，非空即失败）。 */
export function parseWorkflowModel(yaml: string): { model?: WorkflowModel; errors: string[] } {
  const errors: string[] = [];
  const doc = parseDocument(yaml);
  if (doc.errors.length > 0) {
    return { errors: doc.errors.map((e) => `YAML 语法错误: ${e.message}`) };
  }
  const root: unknown = doc.toJS();
  if (!isPlainObject(root)) {
    return { errors: [`顶层必须是映射（mapping），实际为 ${describeKind(root)}`] };
  }

  // 未知顶层键：后端 deny_unknown_fields，保存会被拒绝
  const unknown = Object.keys(root).filter((k) => !KNOWN_TOP_KEYS.has(k));
  if (unknown.length > 0) {
    errors.push(`未知顶层键: ${unknown.join(', ')}（后端将拒绝该文档）`);
  }

  // meta：必填映射；name 必填非空字符串，version 可省默认 1
  let name = '';
  let version = 1;
  let tags: string[] | undefined;
  if (!isPlainObject(root.meta)) {
    errors.push('缺少 meta 映射（meta.name 必填非空字符串，meta.version 可省默认 1）');
  } else {
    if (typeof root.meta.name !== 'string' || root.meta.name.trim() === '') {
      errors.push('meta.name 必须为非空字符串');
    } else {
      name = root.meta.name;
    }
    if (root.meta.version == null) {
      version = 1;
    } else if (typeof root.meta.version !== 'number' || !Number.isFinite(root.meta.version)) {
      errors.push('meta.version 必须为数字（可省略，默认 1）');
    } else {
      version = root.meta.version;
    }
    // tags：可选字符串数组（空数组等同未设，收为 undefined 以省略序列化）
    if (root.meta.tags == null) {
      // 缺省不携带
    } else if (!Array.isArray(root.meta.tags) || !root.meta.tags.every((t) => typeof t === 'string')) {
      errors.push('meta.tags 必须是字符串数组');
    } else if (root.meta.tags.length > 0) {
      tags = root.meta.tags;
    }
  }

  // params：可省（默认 {}）；值为标量（字符串/数字/布尔）
  const params: Record<string, string | number | boolean> = {};
  if (root.params == null) {
    // 缺省 {}
  } else if (!isPlainObject(root.params)) {
    errors.push('params 必须为映射（键 → 标量值）');
  } else {
    for (const [k, v] of Object.entries(root.params)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        params[k] = v;
      } else {
        errors.push(`params.${k} 的值必须为标量（字符串/数字/布尔）`);
      }
    }
  }

  // on_node_failure：可选字符串透传（abort_run | continue_independent 的取值合法性由后端裁决）
  let on_node_failure: string | undefined;
  if (root.on_node_failure == null) {
    // 缺省不携带（后端 None 同 abort_run）
  } else if (typeof root.on_node_failure !== 'string') {
    errors.push('on_node_failure 必须为字符串（abort_run | continue_independent）');
  } else {
    on_node_failure = root.on_node_failure;
  }

  // nodes：可缺省/空；存在时必须为数组，每项 id/agent 为字符串、prompt 可省默认 ''
  const nodes: NodeModel[] = [];
  if (root.nodes == null) {
    // 空工作流合法加载；保存门槛由 validateWorkflow 把守
  } else if (!Array.isArray(root.nodes)) {
    errors.push('nodes 必须为数组');
  } else {
    root.nodes.forEach((raw, i) => {
      if (!isPlainObject(raw)) {
        errors.push(`nodes[${i}] 必须为映射`);
        return;
      }
      if (typeof raw.id !== 'string') {
        errors.push(`nodes[${i}] 缺少字符串 id`);
        return; // 无 id 无法定位后续错误
      }
      if (typeof raw.agent !== 'string') errors.push(`节点 ${raw.id} 缺少字符串 agent`);
      if (raw.prompt != null && typeof raw.prompt !== 'string') {
        errors.push(`节点 ${raw.id} 的 prompt 必须为字符串`);
      }
      const node: NodeModel = {
        id: raw.id,
        agent: typeof raw.agent === 'string' ? raw.agent : '',
        prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
      };
      // retry/timeout_ms/output_schema 透传（后端 serde 权威，不深校验）
      if (raw.output_schema !== undefined) node.output_schema = raw.output_schema;
      if (raw.retry !== undefined) node.retry = raw.retry as RetryModel;
      if (raw.timeout_ms !== undefined) node.timeout_ms = raw.timeout_ms as number;
      nodes.push(node);
    });
  }

  // edges：可缺省；存在时必须为数组，每项 from/to 必填字符串、when 可选字符串
  const edges: EdgeModel[] = [];
  if (root.edges == null) {
    // 缺省 []
  } else if (!Array.isArray(root.edges)) {
    errors.push('edges 必须为数组');
  } else {
    root.edges.forEach((raw, i) => {
      if (!isPlainObject(raw)) {
        errors.push(`edges[${i}] 必须为映射`);
        return;
      }
      if (typeof raw.from !== 'string') errors.push(`edges[${i}] 缺少字符串 from`);
      if (typeof raw.to !== 'string') errors.push(`edges[${i}] 缺少字符串 to`);
      if (raw.when != null && typeof raw.when !== 'string') {
        errors.push(`edges[${i}] 的 when 必须为字符串`);
      }
      if (typeof raw.from === 'string' && typeof raw.to === 'string') {
        const edge: EdgeModel = { from: raw.from, to: raw.to };
        if (typeof raw.when === 'string') edge.when = raw.when;
        edges.push(edge);
      }
    });
  }

  if (errors.length > 0) return { errors };
  const model: WorkflowModel = { name, version, params, nodes, edges };
  if (tags !== undefined) model.tags = tags;
  if (on_node_failure !== undefined) model.on_node_failure = on_node_failure;
  return { model, errors: [] };
}

/** 序列化为后端可解析的 YAML（与 WorkflowDef serde 对齐：meta/params/on_node_failure/nodes/edges 顶层键）。
 *  2 空格缩进、lineWidth 0 不折叠；可选字段为 undefined 时省略；params 为空仍输出 `params: {}`。 */
export function serializeWorkflowYaml(model: WorkflowModel): string {
  return stringify(
    {
      meta: {
        name: model.name,
        version: model.version,
        // 键序 name/version/tags；空数组视为未设（省略字段）
        ...(model.tags !== undefined && model.tags.length > 0 ? { tags: model.tags } : {}),
      },
      params: model.params, // 空映射也输出（{}），保持顶层键稳定
      ...(model.on_node_failure !== undefined ? { on_node_failure: model.on_node_failure } : {}),
      nodes: model.nodes.map((n) => {
        const out: Record<string, unknown> = { id: n.id, agent: n.agent, prompt: n.prompt };
        if (n.output_schema !== undefined) out.output_schema = n.output_schema;
        if (n.retry !== undefined) out.retry = n.retry;
        if (n.timeout_ms !== undefined) out.timeout_ms = n.timeout_ms;
        return out;
      }),
      edges: model.edges.map((e) => {
        const out: Record<string, unknown> = { from: e.from, to: e.to };
        if (e.when !== undefined) out.when = e.when;
        return out;
      }),
    },
    { indent: 2, lineWidth: 0 },
  );
}

/** 就地改写 meta.tags（**文档手术**，区别于 serializeWorkflowYaml 的全量重排）：
 *  parseDocument 后只动 meta.tags 一个键——注释/缩进/其余行原样保留，供文件夹页
 *  「标记」编辑后回写 git 文件（团队 diff 只见 tags 行变化）。
 *  - tags 非空 → meta.set('tags', seq)（已有键原位换值、新键追加到 meta 尾部）；
 *  - tags 为空 → meta.delete('tags')（等同未设）；
 *  - 无 meta 段或非映射（含 yaml 语法错误导致树不完整）→ throw Error（调用方就地提示）。 */
export function setYamlTags(yaml: string, tags: string[]): string {
  const doc = parseDocument(yaml);
  if (doc.errors.length > 0) {
    throw new Error(`YAML 语法错误: ${doc.errors[0].message}`);
  }
  const meta = doc.get('meta');
  if (!isMap(meta)) throw new Error('缺少 meta 段');
  if (tags.length === 0) {
    meta.delete('tags');
  } else {
    meta.set('tags', doc.createNode(tags)); // 字符串数组 → 标量 seq（引用由 yaml 包按需加）
  }
  return String(doc);
}

const KNOWN_TOP_KEYS = new Set(['meta', 'params', 'on_node_failure', 'nodes', 'edges']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function describeKind(v: unknown): string {
  if (v === null) return 'null（空文档）';
  if (Array.isArray(v)) return '数组';
  return typeof v;
}
