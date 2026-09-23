// Run 视图状态：applyEvent 是唯一纯状态转移函数（可单测），
// zustand store 仅做 {view, setRun, apply, reset} 的薄封装。
import { create } from 'zustand';
import type {
  FsEvent,
  LogLinesPayload,
  MsgDeltaPayload,
  PlanSnapshotPayload,
  ToolUpdatePayload,
} from '../api/types';

export interface ToolInfo {
  id: string;
  title?: string;
  kind?: string;
  status: string;
}

export interface NodeView {
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';
  startedAt?: string;
  endedAt?: string;
  message: string;
  reasoning: string[];
  tools: ToolInfo[];
  plan?: { entries: { content: string; priority?: string | null; status: string }[] };
  logs: string[];
  lastToolTitle?: string;
  error?: string;
}

export interface RunView {
  runId: string;
  status: string;
  lastSeq: number;
  nodes: Record<string, NodeView>;
}

/** 单节点日志上限（环形裁剪，保留最新）。 */
const LOG_CAP = 500;

function emptyNode(): NodeView {
  return { status: 'pending', message: '', reasoning: [], tools: [], logs: [] };
}

/** 初始化：全部节点 pending、lastSeq=0（SSE 用 after=0 全量回放）。 */
export function emptyView(runId: string, nodeIds: string[]): RunView {
  const nodes: Record<string, NodeView> = {};
  for (const id of nodeIds) nodes[id] = emptyNode();
  return { runId, status: 'pending', lastSeq: 0, nodes };
}

/** 唯一状态转移（纯函数）：seq 重复/迟到直接丢弃（SSE 重连重放防护）。 */
export function applyEvent(view: RunView, ev: FsEvent): RunView {
  if (ev.seq <= view.lastSeq) return view;
  const next: RunView = { ...view, lastSeq: ev.seq };

  // 节点级补丁助手：node_id 为 null 的 run 级事件直接返回 next；
  // 未知节点的首个事件按 emptyNode 起步（防御 plan/动态节点）。
  const nodeId = ev.node_id;
  const withNode = (patch: (n: NodeView) => NodeView): RunView => {
    if (nodeId == null) return next;
    const base = view.nodes[nodeId] ?? emptyNode();
    return { ...next, nodes: { ...next.nodes, [nodeId]: patch(base) } };
  };

  switch (ev.kind) {
    case 'run.started':
      next.status = 'running';
      return next;
    case 'run.finished':
      next.status = 'finished';
      return next;
    case 'run.failed':
      next.status = 'failed';
      return next;
    case 'run.cancelled':
      next.status = 'cancelled';
      return next;
    case 'run.interrupted':
      next.status = 'interrupted';
      return next;

    case 'node.started':
      return withNode((n) => ({ ...n, status: 'running', startedAt: ev.ts }));
    case 'node.finished':
      return withNode((n) => ({ ...n, status: 'succeeded', endedAt: ev.ts }));
    case 'node.failed':
      return withNode((n) => ({
        ...n,
        status: 'failed',
        endedAt: ev.ts,
        error: ev.payload?.reason,
      }));
    case 'node.cancelled':
      return withNode((n) => ({ ...n, status: 'cancelled', endedAt: ev.ts }));
    case 'node.skipped':
      return withNode((n) => ({ ...n, status: 'skipped' }));
    case 'node.retry':
      // 重试中仍是 running；尚未 started 的节点收到 retry 视为即将重跑
      return withNode((n) => ({ ...n, status: n.status === 'pending' ? 'running' : n.status }));

    case 'msg.delta': {
      const p = ev.payload as MsgDeltaPayload;
      return withNode((n) =>
        p.contentType === 'reasoning'
          ? { ...n, reasoning: [...n.reasoning, p.delta] }
          : { ...n, message: n.message + p.delta },
      );
    }
    case 'tool.update': {
      const p = ev.payload as ToolUpdatePayload;
      return withNode((n) => {
        const idx = n.tools.findIndex((t) => t.id === p.toolCallId);
        let tools: ToolInfo[];
        if (idx >= 0) {
          tools = n.tools.map((t, i) =>
            i === idx
              ? { ...t, status: p.status, ...(p.title !== undefined ? { title: p.title } : {}), ...(p.kind !== undefined ? { kind: p.kind } : {}) }
              : t,
          );
        } else {
          tools = [...n.tools, { id: p.toolCallId, title: p.title, kind: p.kind, status: p.status }];
        }
        return {
          ...n,
          tools,
          ...(p.title !== undefined ? { lastToolTitle: p.title } : {}),
        };
      });
    }
    case 'plan.snapshot': {
      const p = ev.payload as PlanSnapshotPayload;
      return withNode((n) => ({ ...n, plan: { entries: Array.isArray(p.entries) ? p.entries : [] } }));
    }
    case 'log.lines': {
      const p = ev.payload as LogLinesPayload;
      const lines = Array.isArray(p.lines) ? p.lines : [];
      return withNode((n) => ({ ...n, logs: [...n.logs, ...lines].slice(-LOG_CAP) }));
    }

    // session.meta / callback / permission：M1 无 UI 语义，仅推进 lastSeq
    default:
      return next;
  }
}

export interface RunStoreState {
  view: RunView | null;
  setRun: (view: RunView) => void;
  apply: (ev: FsEvent) => void;
  reset: () => void;
}

export const useRunStore = create<RunStoreState>()((set) => ({
  view: null,
  setRun: (view) => set({ view }),
  apply: (ev) =>
    set((s) => (s.view ? { view: applyEvent(s.view, ev) } : {})),
  reset: () => set({ view: null }),
}));
