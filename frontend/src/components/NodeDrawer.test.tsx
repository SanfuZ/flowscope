// 五 tab 各自渲染代表内容；artifact 拉取 mock 掉（vi.mock api 客户端）。
// M2c：头部新增「会话视图」按钮（useNavigate）→ 渲染需 MemoryRouter 包裹。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { NodeView } from '../store/runStore';
import { emptyView, useRunStore } from '../store/runStore';
import NodeDrawer from './NodeDrawer';

vi.mock('../api/client', () => ({
  api: { getArtifact: vi.fn(async () => '{"ok":true,"answer":"周报"}') },
}));

const seededNode: NodeView = {
  status: 'succeeded',
  message: '你好 FlowScope',
  // T3：两段思考 → 单个折叠块，summary 计段数，body 换行连接
  reasoning: ['先思考一下', '再确认数据源'],
  tools: [{ id: 't1', title: '查询数据库', kind: 'fetch', status: 'completed' }],
  plan: {
    entries: [
      { content: '收集数据', status: 'completed' },
      { content: '生成摘要', status: 'in_progress' },
      { content: '发送邮件', status: 'pending' },
    ],
  },
  logs: ['[info] node a start', '[info] node a done'],
};

function renderDrawer() {
  useRunStore.getState().setRun({ ...emptyView('run-1', ['a']), nodes: { a: seededNode } });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/runs/run-1']}>
        <NodeDrawer runId="run-1" nodeId="a" onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  useRunStore.getState().reset();
  vi.clearAllMocks();
});

describe('NodeDrawer：五 tab', () => {
  it('默认消息 tab：message 文本 + reasoning 单折叠块（T3：默认收起、summary 计段数）', () => {
    renderDrawer();
    expect(screen.getByText('你好 FlowScope')).toBeTruthy();
    // T3：单块 —— 不再是每段一个 details
    const blocks = document.querySelectorAll('.fs-reasoning__block');
    expect(blocks).toHaveLength(1);
    const block = blocks[0] as HTMLDetailsElement;
    expect(block.hasAttribute('open')).toBe(false); // 默认收起
    expect(block.querySelector('summary')!.textContent).toBe('思考过程 · 2 段');
    // body = 各段换行连接（两段文本都在块内）
    expect(block.textContent).toContain('先思考一下');
    expect(block.textContent).toContain('再确认数据源');
    expect(screen.getByTestId('drawer-message')).toBeTruthy();
  });

  it('工具 tab：工具行（标题/kind/状态图标）', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('tab', { name: '工具' }));
    const tools = screen.getByTestId('drawer-tools');
    expect(withinText(tools, '查询数据库')).toBe(true);
    expect(withinText(tools, 'fetch')).toBe(true);
    expect(withinText(tools, '✓')).toBe(true);
  });

  it('Plan tab：三条目带状态图标', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('tab', { name: 'Plan' }));
    const plan = screen.getByTestId('drawer-plan');
    expect(withinText(plan, '收集数据')).toBe(true);
    expect(withinText(plan, '生成摘要')).toBe(true);
    expect(withinText(plan, '发送邮件')).toBe(true);
    // completed ✓ / in_progress ◐ / pending ○
    expect(withinText(plan, '✓')).toBe(true);
    expect(withinText(plan, '◐')).toBe(true);
    expect(withinText(plan, '○')).toBe(true);
  });

  it('日志 tab：react-window 渲染日志行', () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('tab', { name: '日志' }));
    const logs = screen.getByTestId('drawer-logs');
    expect(withinText(logs, '[info] node a start')).toBe(true);
    expect(withinText(logs, '[info] node a done')).toBe(true);
  });

  it('输入输出 tab：输入 M2 占位 + 成功后拉取 output artifact', async () => {
    renderDrawer();
    fireEvent.click(screen.getByRole('tab', { name: '输入输出' }));
    const io = screen.getByTestId('drawer-io');
    expect(withinText(io, 'M2')).toBe(true);
    // artifact 经 react-query 异步返回（mock 的 getArtifact）
    await waitFor(() => expect(screen.getByText(/周报/)).toBeTruthy());
    expect(vi.mocked(api.getArtifact)).toHaveBeenCalledWith('run-1', 'a', 'output');
  });
});

describe('NodeDrawer：会话视图入口（M2c）', () => {
  it('头部「会话视图」按钮导航到 /runs/:runId/sess/:nodeId', () => {
    useRunStore.getState().setRun({ ...emptyView('run-1', ['a']), nodes: { a: seededNode } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/runs/run-1']}>
          <Routes>
            <Route
              path="/runs/:runId"
              element={<NodeDrawer runId="run-1" nodeId="a" onClose={() => {}} />}
            />
            <Route
              path="/runs/:runId/sess/:nodeId"
              element={<div data-testid="sess-probe">会话</div>}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('drawer-open-session'));
    expect(screen.getByTestId('sess-probe')).toBeTruthy(); // 已导航到会话路由
  });
});

/** textContent 包含断言的薄封装（react-window 行有内联样式，不便逐节点取）。 */
function withinText(el: HTMLElement, text: string): boolean {
  return el.textContent != null && el.textContent.includes(text);
}
