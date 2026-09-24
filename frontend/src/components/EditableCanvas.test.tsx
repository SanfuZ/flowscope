// Task 4：可编辑画布 + 节点面板。jsdom 无真实 RF 渲染保真度（无布局），
// 测交互接线：palette 列表/添加按钮（→ store 增节点并选中）；空 agent 态；
// store 节点渲染为 NodeCard（data-testid）且点击选中。
// 注：brief 还要求断言「条件边 label 取自 when」，但边渲染需节点测量 +
// SVG 文本 getBBox，jsdom 均不实现（无布局引擎）——label 映射
// （label: e.when / className fs-edge--cond）为纯派生逻辑，留待 e2e 验证。
// api 客户端整体 mock（仅 listAgents 被面板消费）。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { useEditorStore } from '../store/editorStore';
import EditableCanvas from './EditableCanvas';

vi.mock('../api/client', () => ({
  api: { listAgents: vi.fn() },
}));

const AGENTS = [{ key: 'mock', name: 'Mock', permission_default: 'ask', healthy: true }];

// jsdom 未实现 ResizeObserver（React Flow 容器/节点测量依赖）：无操作桩。
// 不模拟真实浏览器「observe 即回调」——那会走到 jsdom 缺失的
// DOMMatrixReadOnly/getBBox/SVG 布局路径（边渲染所需），徒增未捕获异常。
class ResizeObserverStub implements ResizeObserver {
  observe(_target: Element, _options?: ResizeObserverOptions): void {}
  unobserve(_target: Element): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub;
}

function renderCanvas() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReactFlowProvider>
        <EditableCanvas />
      </ReactFlowProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  // zustand 模块级单例：还原到未装载初始态，避免用例间残留
  useEditorStore.setState({
    loaded: false,
    model: null,
    positions: {},
    selected: null,
    dirty: false,
    past: [],
    future: [],
    parseErrors: [],
  });
  vi.clearAllMocks();
});

describe('EditableCanvas：palette 与画布接线', () => {
  it('palette 列出 agent：◆ name (key) 与添加按钮', async () => {
    useEditorStore.getState().loadBlank();
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    renderCanvas();
    expect(await screen.findByTestId('palette-add-mock')).toBeTruthy();
    expect(screen.getByText(/◆ Mock/)).toBeTruthy();
  });

  it('palette 添加按钮向 store 增加节点并选中', async () => {
    useEditorStore.getState().loadBlank();
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    renderCanvas();
    fireEvent.click(await screen.findByTestId('palette-add-mock'));
    const s = useEditorStore.getState();
    expect(s.model!.nodes.length).toBe(2);
    expect(s.model!.nodes[1]!.agent).toBe('mock');
    expect(s.selected?.type).toBe('node');
  });

  it('palette 空态：未注册 agent 提示编辑 agents.toml', async () => {
    useEditorStore.getState().loadBlank();
    vi.mocked(api.listAgents).mockResolvedValue([]);
    renderCanvas();
    expect(await screen.findByText('未注册 agent，请编辑 agents.toml')).toBeTruthy();
  });

  it('store 节点渲染为 NodeCard，点击选中该节点', async () => {
    useEditorStore.getState().loadBlank();
    vi.mocked(api.listAgents).mockResolvedValue([]);
    renderCanvas();
    const card = await screen.findByTestId('node-card');
    fireEvent.click(card);
    expect(useEditorStore.getState().selected).toEqual({ type: 'node', id: 'step1' });
  });
});
