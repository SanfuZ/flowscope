// M2c 节点会话视图单测：api 客户端整体 mock（getRun→workflow_id、getWorkflow→graph），
// jsdom 无 EventSource → 桩类手动发帧。store 为真实 zustand 单例（afterEach 还原）；
// 组件挂载即 reset + 图就绪后 emptyView 初始化（镜像 RunMonitor 管线），
// 故事件种子在初始化落地后（waitFor view.runId）经 applyEvent 注入。
// 组件以 props 接 {runId, nodeId}（App 里另有路由薄壳），直渲染即可。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { FsEvent } from '../api/types';
import { useRunStore } from '../store/runStore';
import NodeSession from './NodeSession';

vi.mock('../api/client', () => ({
  api: {
    getRun: vi.fn(),
    getWorkflow: vi.fn(),
    // useRunEvents 连接用（真实实现拼相对路径）
    eventsUrl: vi.fn((id: string, after: number) => `/api/runs/${id}/events?after=${after}`),
  },
}));

// --- EventSource 桩：记录实例，测试里手动 open()/emit() 驱动 SSE 帧 ---
class EventSourceStub {
  static instances: EventSourceStub[] = [];
  url: string;
  closed = false;
  private listeners = new Map<string, (e: { data: string }) => void>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    EventSourceStub.instances.push(this);
  }

  addEventListener(type: string, cb: (e: { data: string }) => void): void {
    this.listeners.set(type, cb);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  emit(ev: unknown): void {
    this.listeners.get('fs')?.({ data: JSON.stringify(ev) });
  }
}
vi.stubGlobal('EventSource', EventSourceStub);

const frame = (seq: number, kind: FsEvent['kind'], payload: any, node_id = 'a'): FsEvent => ({
  seq,
  ts: '2026-10-03T10:00:00Z',
  run_id: 'run-1',
  node_id,
  session_id: null,
  kind,
  payload,
});

// 完成态事件剧本（对照 demo：prompt → 思考 → 正文 → 工具 → 终态）
const DONE_EVENTS: FsEvent[] = [
  frame(1, 'node.started', { prompt: '做X' }),
  frame(2, 'msg.delta', { delta: '先想想', contentType: 'reasoning' }),
  frame(3, 'msg.delta', { delta: '你好', contentType: 'text' }),
  frame(4, 'tool.update', { toolCallId: 't1', title: '查询', kind: 'search', status: 'in_progress' }),
  frame(5, 'tool.update', { toolCallId: 't1', status: 'completed' }),
  frame(6, 'node.finished', { durationMs: 120 }),
];

// 运行中剧本（无终态事件）
const RUNNING_EVENTS: FsEvent[] = [
  frame(1, 'node.started', { prompt: '做X' }),
  frame(2, 'msg.delta', { delta: '想想…', contentType: 'reasoning' }),
  frame(3, 'tool.update', { toolCallId: 't1', title: '查询', kind: 'search', status: 'in_progress' }),
];

const GRAPH = { nodes: [{ id: 'a', agent: 'mock' }], edges: [] };

function renderSession() {
  vi.mocked(api.getRun).mockResolvedValue({
    id: 'run-1',
    workflow_id: 'wf-1',
    status: 'running',
    started_at: '2026-10-03T10:00:00Z',
    ended_at: null,
  });
  vi.mocked(api.getWorkflow).mockResolvedValue({
    id: 'wf-1',
    name: 'demo',
    version: 1,
    yaml: '',
    graph: GRAPH,
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/runs/run-1/sess/a']}>
        <NodeSession runId="run-1" nodeId="a" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 等图初始化（emptyView）落地后注入事件种子（挂载 effect 会先 reset）。 */
async function renderAndSeed(events: FsEvent[]) {
  renderSession();
  await waitFor(() => expect(useRunStore.getState().view?.runId).toBe('run-1'));
  act(() => {
    events.forEach((e) => useRunStore.getState().apply(e));
  });
}

afterEach(() => {
  cleanup();
  EventSourceStub.instances = [];
  useRunStore.getState().reset();
  vi.clearAllMocks();
});

describe('NodeSession：对话流回放', () => {
  it('完成态：用户气泡=prompt、思考块收起、正文、工具卡 completed、stop chip', async () => {
    await renderAndSeed(DONE_EVENTS);

    expect(screen.getByTestId('user-bubble').textContent).toBe('做X');
    expect(screen.getByTestId('node-banner-prompt').textContent).toBe('session/prompt: 做X');

    const think = screen.getByTestId('think-block');
    expect(think.textContent).toContain('先想想');
    expect(think.hasAttribute('open')).toBe(false); // 终态默认收起
    // T3：summary 计数摘要（1 段，join 后 3 字）
    expect(think.querySelector('summary')!.textContent).toBe('思考过程 · 1 段 · 共 3 字');

    expect(screen.getByTestId('agent-message').textContent).toBe('你好');

    const tool = screen.getByTestId('tool-card');
    expect(tool.textContent).toContain('查询');
    expect(tool.textContent).toContain('🔍'); // kind=search 的 icon
    expect(tool.textContent).toContain('completed');

    expect(screen.getByTestId('stop-chip').textContent).toContain('node.finished');
  });

  it('运行态：思考块也默认收起（T3 去掉 open={running}）、工具徽标 running、无 stop chip；顶栏展示节点标识', async () => {
    await renderAndSeed(RUNNING_EVENTS);

    expect(screen.getByTestId('think-block').hasAttribute('open')).toBe(false); // 运行中同样收起
    // 多段流式思考：段数照实计数（'想想…' 1 段）
    expect(screen.getByTestId('think-block').querySelector('summary')!.textContent).toBe(
      '思考过程 · 1 段 · 共 3 字',
    );
    expect(screen.getByTestId('tool-card').textContent).toContain('running');
    expect(screen.queryByTestId('stop-chip')).toBeNull();
    expect(screen.getByTestId('sess-conn').textContent).toContain('SSE');
    expect(screen.getByTestId('sess-topbar').textContent).toContain('mock / a'); // agent / nodeId
  });

  it('T3：思考总字数 >=1000 显示 1.2k 样式，summary 段数照实', async () => {
    await renderAndSeed([
      frame(1, 'node.started', { prompt: '做X' }),
      frame(2, 'msg.delta', { delta: '想'.repeat(600), contentType: 'reasoning' }),
      frame(3, 'msg.delta', { delta: '再'.repeat(600), contentType: 'reasoning' }),
    ]);
    // 2 段、join 后 1200 字 → 1.2k
    expect(screen.getByTestId('think-block').querySelector('summary')!.textContent).toBe(
      '思考过程 · 2 段 · 共 1.2k 字',
    );
  });

  it('无事件：banner 显示等待事件…、无用户气泡', async () => {
    await renderAndSeed([]);
    expect(screen.getByTestId('node-banner-prompt').textContent).toContain('等待事件…');
    expect(screen.queryByTestId('user-bubble')).toBeNull();
  });
});

describe('NodeSession：协议事件抽屉（onEvent 旁路）', () => {
  it('SSE 帧进抽屉（仅本节点），单击行展开完整 pretty JSON', async () => {
    await renderAndSeed([DONE_EVENTS[0]]);
    // SSE 直发一帧（node_id=a）→ 同时进 store（正文）与抽屉
    const es = EventSourceStub.instances.at(-1)!;
    act(() => es.open());
    act(() => es.emit(frame(2, 'msg.delta', { delta: 'hi', contentType: 'text' })));
    expect(screen.getByTestId('agent-message').textContent).toBe('hi');
    expect(screen.getByTestId('sess-conn').textContent).toContain('SSE 已连接');

    fireEvent.click(screen.getByTestId('protocol-drawer-toggle')); // 默认折叠 → 展开
    const rows = screen.getAllByTestId('proto-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('msg.delta');
    expect(rows[0].textContent).not.toContain('\n'); // 摘要为单行
    // 非本节点事件不进抽屉
    act(() => es.emit(frame(3, 'msg.delta', { delta: 'other', contentType: 'text' }, 'b')));
    expect(screen.getAllByTestId('proto-row')).toHaveLength(1);

    fireEvent.click(rows[0]); // 行单击 → 完整 pretty JSON（多行 + 冒号带空格）
    expect(rows[0].textContent).toContain('"delta": "hi"');
    expect(rows[0].textContent).toContain('\n');
    fireEvent.click(rows[0]); // 再点收起
    expect(rows[0].textContent).not.toContain('"delta": "hi"');
  });
});
