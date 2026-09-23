// 同源 REST 客户端：后端与前端同源部署（后端静态托管 frontend/dist），
// dev 模式经 vite 代理，因此基址就是 window.location.origin。
// 非 2xx → 抛 Error(body.error)（后端错误统一为 {"error": "..."}）。
import { parseWorkflowGraph } from './graph';
import type { RunRow, StartRunResult, WorkflowDetail, WorkflowGraph, WorkflowSummary } from './types';

const BASE = window.location.origin;

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: init?.body != null ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') msg = body.error;
    } catch {
      /* 非 JSON 错误体，保留状态码信息 */
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** GET /api/workflows/:id 原始行（{id,name,version,yaml}）。 */
interface WorkflowRow {
  id: string;
  name: string;
  version: number;
  yaml: string;
}

export const api = {
  listWorkflows: () => req<WorkflowSummary[]>('/api/workflows'),

  getWorkflow: async (id: string): Promise<WorkflowDetail> => {
    const row = await req<WorkflowRow>(`/api/workflows/${encodeURIComponent(id)}`);
    return { ...row, graph: parseWorkflowGraph(row.yaml) };
  },

  /** POST /api/workflows {yaml}；name/version 由服务端从 yaml 的 meta 解析
   *  （入参保留以供调用方表达意图，请求体按契约只带 yaml）。 */
  saveWorkflow: (_name: string, _version: number, yaml: string): Promise<{ id: string }> =>
    req<{ id: string }>('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ yaml }),
    }),

  deleteWorkflow: (id: string): Promise<void> =>
    req<void>(`/api/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  listRuns: () => req<RunRow[]>('/api/runs'),

  getRun: (id: string): Promise<RunRow> => req<RunRow>(`/api/runs/${encodeURIComponent(id)}`),

  startRun: (workflowId: string, params: Record<string, unknown> | undefined): Promise<StartRunResult> =>
    req<StartRunResult>(`/api/workflows/${encodeURIComponent(workflowId)}/runs`, {
      method: 'POST',
      body: JSON.stringify(params === undefined ? {} : { params }),
    }),

  cancelRun: (id: string): Promise<{ ok: boolean }> =>
    req<{ ok: boolean }>(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),

  /** GET /api/runs/:id/artifacts/:node/:name —— 后端按存储 content_type 原样
   *  返回内容（非 JSON 信封），故不走 req<T>，返回纯文本由调用方解析。 */
  getArtifact: async (runId: string, node: string, name: string): Promise<string> => {
    const res = await fetch(
      `${BASE}/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(node)}/${encodeURIComponent(name)}`,
    );
    if (!res.ok) throw new Error(`artifact ${node}/${name} HTTP ${res.status}`);
    return res.text();
  },

  /** SSE 订阅地址（相对路径，EventSource 会拼上当前 origin）。 */
  eventsUrl: (runId: string, after: number): string =>
    `/api/runs/${encodeURIComponent(runId)}/events?after=${after}`,
};

/** 供需要图结构但已有 yaml 文本的调用方复用（如编辑器预览）。 */
export { parseWorkflowGraph };
export type { WorkflowGraph };
