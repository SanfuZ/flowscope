// Task 6：WorkflowDetail 画布为主交互重写测试。渲染整页（EditableCanvas +
// PropertyPanel + 工具栏），createMemoryRouter data router 定路由参数（save-ux
// 的 useBlocker 需要）/ ReactFlowProvider 供画布取实例 / QueryClientProvider
// 供 react-query；api 客户端整体 mock。
// store 用真实 zustand 单例（afterEach 还原），禁用态断言用 .disabled 属性
//（项目未引入 jest-dom，沿用既有测试约定）。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
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

// 渲染到 data router（createMemoryRouter + RouterProvider）：save-ux 的
// useBlocker（未保存离开拦截）在 react-router 6.19+ 仅于 data router 上下文
// 可用。返回 render 结果 + router（供用例直接 router.navigate 触发拦截）。
function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/workflows/:id', element: <WorkflowDetail /> },
      { path: '/runs/:id', element: <div data-testid="run-probe">run page</div> },
      { path: '/other', element: <div data-testid="other-page">other page</div> },
    ],
    { initialEntries: [path] },
  );
  const view = render(
    <QueryClientProvider client={qc}>
      <ReactFlowProvider>
        <RouterProvider router={router} />
      </ReactFlowProvider>
    </QueryClientProvider>,
  );
  return { ...view, router };
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

describe('WorkflowDetail：save-ux 快捷键与 toast', () => {
  it('Ctrl+S 触发保存（脏态 + 校验通过）；有校验问题时不触发', async () => {
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
    await waitFor(() => expect(useEditorStore.getState().loaded).toBe(true));
    act(() => useEditorStore.getState().addNode('mock')); // 脏态
    expect(useEditorStore.getState().dirty).toBe(true);

    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => expect(vi.mocked(api.saveWorkflow)).toHaveBeenCalledTimes(1));

    // 校验有问题（meta.name 为空）→ Ctrl+S 不触发保存
    await waitFor(() => expect(useEditorStore.getState().dirty).toBe(false)); // 上次保存已清脏
    act(() => useEditorStore.getState().updateModelMeta({ name: '' }));
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await act(async () => {}); // 冲刷微任务，确认无第二次调用
    expect(vi.mocked(api.saveWorkflow)).toHaveBeenCalledTimes(1);
  });

  it('保存成功弹 fs-toast（✓ 已保存 + 名称），2.2s 后自动消失', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    vi.mocked(api.getWorkflow).mockResolvedValue({
      id: 'abc',
      name: 'demo',
      version: 1,
      yaml: VALID_YAML,
      graph: parseWorkflowGraph(VALID_YAML),
    });
    // 手动决出的 promise：真定时器阶段发起保存，假时钟阶段 resolve，
    // 使 2200ms 的 toast 计时器确定性可推进。
    let resolveSave!: (v: { id: string }) => void;
    vi.mocked(api.saveWorkflow).mockImplementation(
      () => new Promise((res) => { resolveSave = res; }),
    );
    renderAt('/workflows/abc');
    const save = (await screen.findByRole('button', { name: '保存' })) as HTMLButtonElement;
    await waitFor(() => expect(useEditorStore.getState().loaded).toBe(true));
    act(() => useEditorStore.getState().addNode('mock')); // 脏态 → 保存按钮高亮

    fireEvent.click(save);
    expect(screen.queryByTestId('save-toast')).toBeNull(); // 成功前无 toast
    // mutate 的 mutationFn 在微任务里执行：真定时器阶段等到 mock 被调用
    //（resolveSave 已赋值），再切假时钟确定性推进 toast 计时器。
    await waitFor(() => expect(vi.mocked(api.saveWorkflow)).toHaveBeenCalled());
    vi.useFakeTimers();
    try {
      await act(async () => resolveSave({ id: 'abc' }));
      const toast = screen.getByTestId('save-toast');
      expect(toast.textContent).toContain('✓ 已保存');
      expect(toast.textContent).toContain('demo');
      act(() => vi.advanceTimersByTime(2300));
      expect(screen.queryByTestId('save-toast')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WorkflowDetail：save-ux 未保存离开拦截', () => {
  it('脏态路由跳转弹确认模态：留下留在原页，离开放行', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    vi.mocked(api.getWorkflow).mockResolvedValue({
      id: 'abc',
      name: 'demo',
      version: 1,
      yaml: VALID_YAML,
      graph: parseWorkflowGraph(VALID_YAML),
    });
    const { router } = renderAt('/workflows/abc');
    await waitFor(() => expect(useEditorStore.getState().loaded).toBe(true));
    act(() => useEditorStore.getState().addNode('mock')); // 脏态
    expect(useEditorStore.getState().dirty).toBe(true);

    // 脏态跳转 → 拦截：模态出现，目标页未渲染
    //（async act 冲刷 RouterProvider 的 useSyncExternalStore 更新，导航确定落地）
    await act(async () => router.navigate('/other'));
    await screen.findByRole('dialog', { name: '有未保存的修改' });
    expect(screen.queryByTestId('other-page')).toBeNull();

    // 留下：模态关闭，URL/内容留在原页
    fireEvent.click(screen.getByRole('button', { name: '留下' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('other-page')).toBeNull();

    // 再次跳转 → 离开：放行到目标页
    await act(async () => router.navigate('/other'));
    await screen.findByRole('dialog', { name: '有未保存的修改' });
    fireEvent.click(screen.getByRole('button', { name: '离开' }));
    await screen.findByTestId('other-page');
  });

  it('保存成功后的 new → /workflows/:id 跳转不被拦截（markSaved 先于 navigate）', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    vi.mocked(api.saveWorkflow).mockResolvedValue({ id: 'wf-new' });
    renderAt('/workflows/new');
    const save = (await screen.findByRole('button', { name: '保存' })) as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    fireEvent.click(save);
    await waitFor(() => expect(useEditorStore.getState().dirty).toBe(false)); // markSaved
    // 导航确实发生（标题从「新建工作流」变为「工作流：…」= id 已切换），且全程无拦截模态
    await waitFor(() => expect(screen.queryByText('新建工作流')).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
