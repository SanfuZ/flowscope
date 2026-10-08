// 同源 REST 客户端：后端与前端同源部署（后端静态托管 frontend/dist），
// dev 模式经 vite 代理，因此基址就是 window.location.origin。
// 非 2xx → 抛 Error(body.error)（后端错误统一为 {"error": "..."}）。
import { parseWorkflowGraph } from './graph';
import type { AgentRow, RunRow, StartRunResult, WorkflowDetail, WorkflowGraph, WorkflowSummary } from './types';

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

/** GET /api/fs/workflows 行：文件夹里的一个工作流 YAML。valid:false 时
 *  name 回退文件名去扩展名、version 为 null、error 带解析消息——yaml 仍是
 *  文件全文，失败项也可带进编辑器修。tags 为 meta.tags（缺省空数组）。 */
export interface FolderWorkflow {
  file: string;
  name: string;
  version: number | null;
  valid: boolean;
  error: string | null;
  yaml: string;
  tags: string[];
}

export const api = {
  listWorkflows: () => req<WorkflowSummary[]>('/api/workflows'),

  /** GET /api/fs/workflows?dir=…：只读列出磁盘目录中的工作流 YAML（后端已按
   *  名称字母序排序）；dir 省略时用后端默认目录（env FLOWSCOPE_WORKFLOW_DIR
   *  → ~/.flowscope/workflows），响应里的 dir 为解析后的实际目录。 */
  listFolderWorkflows: (dir?: string): Promise<{ dir: string; files: FolderWorkflow[] }> =>
    req<{ dir: string; files: FolderWorkflow[] }>(
      `/api/fs/workflows${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`,
    ),

  /** POST /api/fs/workflows/save {dir, file, yaml}：把编辑器当前内容写回
   *  来源 git 文件夹的同名文件（覆盖；后端校验目录存在/文件名防穿越/YAML
   *  可解析），响应 {dir, file, bytes}。 */
  saveFolderWorkflow: (body: { dir: string; file: string; yaml: string }): Promise<{ dir: string; file: string; bytes: number }> =>
    req<{ dir: string; file: string; bytes: number }>('/api/fs/workflows/save', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** GET /api/agents：agents.toml 注册的 agent 清单（画布编辑器面板）。 */
  listAgents: (): Promise<AgentRow[]> => req<AgentRow[]>('/api/agents'),

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
