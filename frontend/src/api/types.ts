// 与 Rust 后端（crates/flowscope-core）serde 序列化对齐的线格式类型。
// 线格式字段为 snake_case（FsEvent/RunRow/WorkflowRow 原样透传）；
// payload 内部字段按控制器裁定为 camelCase（见下方各 payload 接口）。

export type EventKind =
  | 'run.started'
  | 'run.finished'
  | 'run.failed'
  | 'run.cancelled'
  | 'run.interrupted'
  | 'node.started'
  | 'node.finished'
  | 'node.cancelled'
  | 'node.failed'
  | 'node.skipped'
  | 'node.retry'
  | 'msg.delta'
  | 'tool.update'
  | 'plan.snapshot'
  | 'session.meta'
  | 'log.lines'
  | 'callback'
  | 'permission';

/** SSE 帧 data（GET /api/runs/:id/events，event 名为 "fs"）。 */
export interface FsEvent {
  seq: number;
  ts: string;
  run_id: string;
  node_id: string | null;
  session_id: string | null;
  kind: EventKind;
  payload: any;
}

// --- payload 契约（与 engine.rs emit 的 json! 对齐，camelCase） ---

export interface MsgDeltaPayload {
  delta: string;
  contentType: 'text' | 'reasoning';
}

export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'error';

export interface ToolUpdatePayload {
  toolCallId: string;
  title?: string;
  kind?: string;
  status: ToolStatus;
  content?: any[];
}

/** plan 快照为扁平 entries（无 id），按 content 渲染。 */
export interface PlanEntry {
  content: string;
  priority?: string | null;
  status: string;
}

export interface PlanSnapshotPayload {
  entries: PlanEntry[];
}

export interface LogLinesPayload {
  lines: string[];
  level: string;
}

/** node.finished / node.failed / node.cancelled 终态 payload。 */
export interface NodeTerminalPayload {
  durationMs?: number;
  reason?: string;
}

export interface NodeRetryPayload {
  attempt: number;
  max: number;
}

export interface RunStartedPayload {
  workflowName?: string;
  params?: Record<string, unknown>;
}

// --- REST 行类型 ---

export interface WorkflowSummary {
  id: string;
  name: string;
  version: number;
}

/** GET /api/workflows/:id 返回 {id,name,version,yaml}；graph 由前端从 yaml 提取。 */
export interface WorkflowDetail extends WorkflowSummary {
  yaml: string;
  graph: WorkflowGraph;
}

export interface WorkflowGraph {
  nodes: { id: string; agent: string }[];
  edges: { from: string; to: string; when?: string }[];
}

export interface RunRow {
  id: string;
  workflow_id: string;
  status: string;
  params?: unknown;
  started_at: string;
  ended_at: string | null;
}

export interface StartRunResult {
  run_id: string;
}
