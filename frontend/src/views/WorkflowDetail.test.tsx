// Task 6：WorkflowDetail 画布为主交互重写测试。渲染整页（EditableCanvas +
// PropertyPanel + 工具栏），MemoryRouter 定路由参数 / ReactFlowProvider 供画布
// 取实例 / QueryClientProvider 供 react-query；api 客户端整体 mock。
// store 用真实 zustand 单例（afterEach 还原），禁用态断言用 .disabled 属性
//（项目未引入 jest-dom，沿用既有测试约定）。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { parseWorkflowGraph } from '../api/graph';
import { useEditorStore } from '../store/editorStore';
import WorkflowDetail from './WorkflowDetail';

vi.mock('../api/client', () => ({
  api: {
    listAgents: vi.fn(),
    getWorkflow: vi.fn(),
    saveWorkflow: vi.fn(),
    startRun: vi.fn(),
  },
}));

const AGENTS = [{ key: 'mock', name: 'Mock', permission_default: 'ask', healthy: true }];

/** 校验通过的合法 YAML（save 门通过 → 保存可点）。 */
const VALID_YAML = `meta:
  name: demo
  version: 1
params: {}
nodes:
  - id: step1
    agent: mock
    prompt: ''
edges: []
`;

/** 带一个 param 的工作流（启动裁定：params 取 model.params）。 */
const LAUNCH_YAML = `meta:
  name: demo
  version: 1
params:
  env: prod
nodes:
  - id: step1
    agent: mock
    prompt: ''
edges: []
`;

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReactFlowProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/workflows/:id" element={<WorkflowDetail />} />
            <Route
              path="/runs/:id"
              element={<div data-testid="run-probe">run page</div>}
            />
          </Routes>
        </MemoryRouter>
      </ReactFlowProvider>
    </QueryClientProvider>,
  );
}

// jsdom 未实现 ResizeObserver（React Flow 容器测量依赖）：无操作桩。
// （同 EditableCanvas.test.tsx——不模拟 observe 回调，避开 jsdom 缺失的
// DOMMatrixReadOnly/getBBox 路径。）
class ResizeObserverStub implements ResizeObserver {
  observe(_target: Element, _options?: ResizeObserverOptions): void {}
  unobserve(_target: Element): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub;
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

describe('WorkflowDetail：工具栏', () => {
  it('渲染 保存/启动运行/撤销/重做/YAML 源码 五个工具栏按钮', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    renderAt('/workflows/new');
    await screen.findByRole('button', { name: '保存' }); // loadBlank 已落地
    expect(screen.getByRole('button', { name: '启动运行' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '撤销' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '重做' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'YAML 源码' })).toBeTruthy();
  });

  it('撤销空历史禁用，编辑后启用；撤销后重做启用', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    renderAt('/workflows/new');
    const undo = (await screen.findByRole('button', { name: '撤销' })) as HTMLButtonElement;
    const redoBtn = screen.getByRole('button', { name: '重做' }) as HTMLButtonElement;
    expect(undo.disabled).toBe(true);
    expect(redoBtn.disabled).toBe(true);

    fireEvent.click(await screen.findByTestId('palette-add-mock')); // 一次画布编辑
    expect(undo.disabled).toBe(false);
    fireEvent.click(undo);
    expect(undo.disabled).toBe(true);
    expect(redoBtn.disabled).toBe(false);
  });

  it('Ctrl+Z 撤销 / Ctrl+Shift+Z 重做（页面容器键盘）', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    const { container } = renderAt('/workflows/new');
    await screen.findByTestId('palette-add-mock');
    fireEvent.click(screen.getByTestId('palette-add-mock'));
    expect(useEditorStore.getState().model!.nodes.length).toBe(2);
    const page = container.querySelector('.fs-page--editor')!;
    fireEvent.keyDown(page, { key: 'z', ctrlKey: true });
    expect(useEditorStore.getState().model!.nodes.length).toBe(1);
    fireEvent.keyDown(page, { key: 'y', ctrlKey: true }); // Ctrl+Y 同重做
    expect(useEditorStore.getState().model!.nodes.length).toBe(2);
    fireEvent.keyDown(page, { key: 'z', ctrlKey: true });
    expect(useEditorStore.getState().model!.nodes.length).toBe(1);
    fireEvent.keyDown(page, { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(useEditorStore.getState().model!.nodes.length).toBe(2);
  });

  it('校验错误时保存禁用 + 徽章 ⚠，修复后恢复 + 徽章 ✓ 通过', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    renderAt('/workflows/new');
    const save = (await screen.findByRole('button', { name: '保存' })) as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    act(() => useEditorStore.getState().updateModelMeta({ name: '' }));
    expect(save.disabled).toBe(true);
    expect(save.title).toContain('meta.name');
    screen.getByText('⚠ 1');

    act(() => useEditorStore.getState().updateModelMeta({ name: 'fixed' }));
    expect(save.disabled).toBe(false);
    screen.getByText('✓ 通过');
  });
});

describe('WorkflowDetail：YAML 源码浮层', () => {
  it('打开显示 toYaml 快照；改文本应用到画布后 model 更新', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    renderAt('/workflows/new');
    await screen.findByRole('button', { name: '保存' });

    fireEvent.click(screen.getByRole('button', { name: 'YAML 源码' }));
    screen.getByText('图形编辑后导出会重排格式、注释不保留');
    const ta = screen.getByLabelText('YAML 内容') as HTMLTextAreaElement;
    expect(ta.value).toContain('name: my-workflow');
    expect(ta.value).toContain('id: step1');

    fireEvent.change(ta, { target: { value: ta.value.replace('name: my-workflow', 'name: renamed-wf') } });
    fireEvent.click(screen.getByRole('button', { name: '应用到画布' }));
    expect(useEditorStore.getState().model!.name).toBe('renamed-wf');
    expect(screen.queryByLabelText('YAML 内容')).toBeNull(); // 成功后关闭
  });

  it('应用非法 YAML：parseErrors 就地显示且不关闭浮层', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    renderAt('/workflows/new');
    await screen.findByRole('button', { name: '保存' });

    fireEvent.click(screen.getByRole('button', { name: 'YAML 源码' }));
    const ta = screen.getByLabelText('YAML 内容') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'meta: [oops' } });
    fireEvent.click(screen.getByRole('button', { name: '应用到画布' }));
    screen.getByText(/YAML 语法错误/);
    expect(screen.queryByLabelText('YAML 内容')).not.toBeNull(); // 不关闭
    // 画布文档未被覆盖（仍是空白文档）
    expect(useEditorStore.getState().model!.name).toBe('my-workflow');
  });
});

describe('WorkflowDetail：启动与保存门', () => {
  it('/workflows/new 启动运行禁用（title 请先保存）', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    renderAt('/workflows/new');
    const btn = (await screen.findByRole('button', { name: '启动运行' })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe('请先保存');
  });

  it('已载入工作流一键启动：startRun(id, model.params) 成功后跳 /runs/:id', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    vi.mocked(api.getWorkflow).mockResolvedValue({
      id: 'abc',
      name: 'demo',
      version: 1,
      yaml: LAUNCH_YAML,
      graph: parseWorkflowGraph(LAUNCH_YAML),
    });
    vi.mocked(api.startRun).mockResolvedValue({ run_id: 'r-9' });
    renderAt('/workflows/abc');

    const btn = (await screen.findByRole('button', { name: '启动运行' })) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false)); // 载入完成即启用（无需画布交互）
    fireEvent.click(btn);
    expect(vi.mocked(api.startRun)).toHaveBeenCalledWith('abc', { env: 'prod' });
    await screen.findByTestId('run-probe'); // 已导航到运行页
  });

  it('既有工作流载入后保存可点（M1 语义：不要求先编辑）', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    vi.mocked(api.getWorkflow).mockResolvedValue({
      id: 'abc',
      name: 'demo',
      version: 1,
      yaml: VALID_YAML,
      graph: parseWorkflowGraph(VALID_YAML),
    });
    vi.mocked(api.saveWorkflow).mockResolvedValue({ id: 'abc' });
    renderAt('/workflows/abc');

    const save = (await screen.findByRole('button', { name: '保存' })) as HTMLButtonElement;
    await waitFor(() => expect(useEditorStore.getState().loaded).toBe(true));
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(vi.mocked(api.saveWorkflow)).toHaveBeenCalledWith('demo', 1, expect.stringContaining('name: demo')),
    );
    expect(useEditorStore.getState().dirty).toBe(false); // markSaved
  });
});
