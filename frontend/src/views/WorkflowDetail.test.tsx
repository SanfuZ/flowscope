// Task 6：WorkflowDetail 画布为主交互重写测试。渲染整页（EditableCanvas +
// PropertyPanel + 工具栏），createMemoryRouter data router 定路由参数（save-ux
// 的 useBlocker 需要）/ ReactFlowProvider 供画布取实例 / QueryClientProvider
// 供 react-query；api 客户端整体 mock。
// store 用真实 zustand 单例（afterEach 还原），禁用态断言用 .disabled 属性
//（项目未引入 jest-dom，沿用既有测试约定）。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    saveFolderWorkflow: vi.fn(),
    listFolderWorkflows: vi.fn(),
    startRun: vi.fn(),
  },
}));

// T1 起 Palette 过滤演示 agent（mock/bad-mock）——面板接线用例改用非演示 key `corp`。
const AGENTS = [{ key: 'corp', name: 'Corp', permission_default: 'ask', healthy: true }];

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
// state：可选路由 state（文件夹工作流导入入口用 location.state.importedYaml）。
function renderAt(path: string, state?: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/workflows/:id', element: <WorkflowDetail /> },
      { path: '/runs/:id', element: <div data-testid="run-probe">run page</div> },
      { path: '/other', element: <div data-testid="other-page">other page</div> },
    ],
    { initialEntries: [{ pathname: path, state }] },
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
  localStorage.removeItem('fs-workflow-dir'); // 对话框目录缓存不跨用例
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
    // T1 收尾：agents 就绪后种子节点自动换 agent（updateNode 正常进历史）
    // → 新建页初始即有一步可撤历史
    await waitFor(() => expect(undo.disabled).toBe(false));
    expect(redoBtn.disabled).toBe(true);

    fireEvent.click(await screen.findByTestId('palette-add-corp')); // 一次画布编辑
    expect(undo.disabled).toBe(false);
    fireEvent.click(undo); // 撤销 addNode
    expect(useEditorStore.getState().model!.nodes.length).toBe(1);
    fireEvent.click(undo); // 撤销种子换选
    expect(undo.disabled).toBe(true); // 回到空白快照：历史耗尽
    expect(useEditorStore.getState().model!.nodes[0].agent).toBe('mock');
    expect(redoBtn.disabled).toBe(false);
  });

  it('Ctrl+Z 撤销 / Ctrl+Shift+Z 重做（页面容器键盘）', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    const { container } = renderAt('/workflows/new');
    await screen.findByTestId('palette-add-corp');
    fireEvent.click(screen.getByTestId('palette-add-corp'));
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

describe('WorkflowDetail：新建种子自动换选（T1 收尾）', () => {
  const AGENTS_WITH_ZCODE = [
    { key: 'mock', name: 'Mock', permission_default: 'ask', healthy: true },
    { key: 'zcode', name: 'ZCode', permission_default: 'ask', healthy: true },
  ];

  it('isNew：agents 就绪后未碰过的 step1 自动换成首个非演示 agent', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS_WITH_ZCODE);
    renderAt('/workflows/new');
    await waitFor(() =>
      expect(useEditorStore.getState().model!.nodes[0].agent).toBe('zcode'),
    );
    const n = useEditorStore.getState().model!.nodes[0];
    expect(n.id).toBe('step1'); // 仅换 agent，种子身份不变
    expect(n.prompt).toBe('');
    expect(useEditorStore.getState().dirty).toBe(true); // 走 updateNode 正常编辑纪律（可撤销）
  });

  it('isNew：用户已编辑（脏）→ 种子保持 mock 不被自动换', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS_WITH_ZCODE);
    renderAt('/workflows/new');
    // 同步置脏（先于 agents 查询 resolve 的微任务）：模拟用户抢先编辑
    act(() => useEditorStore.getState().updateNode('step1', { prompt: 'my-prompt' }));
    await act(async () => {}); // 冲刷 agents resolve 与后续 effects
    expect(useEditorStore.getState().model!.nodes[0].agent).toBe('mock');
    expect(useEditorStore.getState().model!.nodes[0].prompt).toBe('my-prompt');
  });

  it('isNew：注册的全是演示 agent → 种子保持 mock（纯演示环境新建仍可用）', async () => {
    vi.mocked(api.listAgents).mockResolvedValue([
      { key: 'mock', name: 'Mock', permission_default: 'ask', healthy: true },
      { key: 'bad-mock', name: 'Bad', permission_default: 'ask', healthy: true },
    ]);
    renderAt('/workflows/new');
    await act(async () => {});
    await act(async () => {}); // 再冲刷一轮，确认不会有延迟换选
    expect(useEditorStore.getState().model!.nodes[0].agent).toBe('mock');
  });
});

describe('WorkflowDetail：文件夹工作流导入入口', () => {
  // 含 zcode（非演示 agent）：若种子换选未被跳过，mock 会被自动换成 zcode。
  const AGENTS_WITH_ZCODE = [
    { key: 'mock', name: 'Mock', permission_default: 'ask', healthy: true },
    { key: 'zcode', name: 'ZCode', permission_default: 'ask', healthy: true },
  ];
  // 刻意与空白种子同形（单节点 step1 + agent mock）：name/prompt 不同证明
  // 载入的是导入内容而非 loadBlank；agent 保持 mock 证明种子换选 effect 被
  // importedRef 跳过（否则注册表含 zcode 时会被自动换成 zcode）。
  const IMPORTED_YAML = `meta:
  name: imported-wf
  version: 3
nodes:
  - id: step1
    agent: mock
    prompt: from-folder
edges: []
`;

  it('/workflows/new 带 location.state.importedYaml：载入导入内容而非空白，且跳过种子换选', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS_WITH_ZCODE);
    renderAt('/workflows/new', { importedYaml: IMPORTED_YAML });
    await waitFor(() => expect(useEditorStore.getState().loaded).toBe(true));
    const m = useEditorStore.getState().model!;
    expect(m.name).toBe('imported-wf'); // 不是 loadBlank 的 my-workflow
    expect(m.version).toBe(3);
    expect(m.nodes[0].id).toBe('step1');
    expect(m.nodes[0].prompt).toBe('from-folder');
    expect(m.nodes[0].agent).toBe('mock'); // 导入的 YAML 是权威内容
    await act(async () => {}); // 冲刷 agents resolve 与后续 effects
    await act(async () => {}); // 再冲刷一轮：确认没有延迟换选
    expect(useEditorStore.getState().model!.nodes[0].agent).toBe('mock');
    expect(useEditorStore.getState().dirty).toBe(false); // 干净文档可直接保存
  });

  it('导入解析失败的 YAML：自动打开 YAML 层展示原文与错误，修复后应用到画布落地', async () => {
    const BAD_YAML = 'meta: [broken';
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS_WITH_ZCODE);
    renderAt('/workflows/new', { importedYaml: BAD_YAML });

    // YAML 层自动打开：文本框 = 导入原文（此时 model null，toYaml() 为空串
    // 导不出——快照必须来自导入原文），store 的 parseErrors 就地显示
    const ta = (await screen.findByLabelText('YAML 内容')) as HTMLTextAreaElement;
    expect(ta.value).toBe(BAD_YAML);
    screen.getByText(/YAML 语法错误/);
    expect(useEditorStore.getState().model).toBeNull(); // 画布为空（未落地）

    // 用户在文本框修复为最小合法工作流 → 应用到画布 → 文档落地、浮层关闭
    fireEvent.change(ta, {
      target: {
        value:
          'meta: {name: fixed-wf, version: 2}\nnodes:\n  - {id: n1, agent: m, prompt: p}\n',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '应用到画布' }));
    await waitFor(() => expect(useEditorStore.getState().model?.name).toBe('fixed-wf'));
    expect(useEditorStore.getState().model!.version).toBe(2);
    expect(useEditorStore.getState().model!.nodes[0].id).toBe('n1');
    expect(screen.queryByLabelText('YAML 内容')).toBeNull(); // 成功后关闭
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

describe('WorkflowDetail：保存到文件夹（通用化 + 另存派生）', () => {
  const ORIGIN_DIR = 'D:/team/wf';
  const ORIGIN_FILE = 'a.yaml';
  // 含 tags（写回文件夹时随 YAML 保留；另存对话框「标记」初值来源）
  const ORIGIN_YAML = `meta:
  name: origin-wf
  version: 3
  tags:
    - 演示
params: {}
nodes:
  - id: step1
    agent: mock
    prompt: from-folder
edges: []
`;

  it('无 origin state：「保存到文件夹」「另存到文件夹…」常驻工具栏', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    renderAt('/workflows/new');
    const btn = (await screen.findByRole('button', { name: '保存到文件夹' })) as HTMLButtonElement;
    expect(screen.getByRole('button', { name: '另存到文件夹…' })).toBeTruthy();
    expect(btn.title).toBe('选择目录与文件名，保存到 git 文件夹'); // 无直达路径提示走对话框
  });

  it('无 origin 点击「保存到文件夹」弹对话框：文件名=模型名合法化补 .yaml，目录无缓存时静默取后端默认', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    vi.mocked(api.listFolderWorkflows).mockResolvedValue({ dir: 'D:/default/wf', files: [] });
    renderAt('/workflows/new');
    await waitFor(() => expect(useEditorStore.getState().loaded).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: '保存到文件夹' }));
    const dlg = screen.getByRole('dialog', { name: '保存到文件夹' });
    expect((within(dlg).getByLabelText('文件名') as HTMLInputElement).value).toBe('my-workflow.yaml'); // loadBlank 名 + 补后缀
    expect((within(dlg).getByLabelText('标记') as HTMLInputElement).value).toBe(''); // 无 tags
    const dirInput = within(dlg).getByLabelText('目录路径') as HTMLInputElement;
    await waitFor(() => expect(dirInput.value).toBe('D:/default/wf')); // 后端默认目录回填
    expect(vi.mocked(api.listFolderWorkflows)).toHaveBeenCalledWith(); // 无参（后端默认目录）
  });

  it('localStorage 已有目录缓存：对话框直接预填缓存且不请求后端', async () => {
    localStorage.setItem('fs-workflow-dir', 'D:/cached');
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    renderAt('/workflows/new');
    await waitFor(() => expect(useEditorStore.getState().loaded).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: '另存到文件夹…' })); // 无 origin 也常驻可用
    const dlg = screen.getByRole('dialog', { name: '保存到文件夹' });
    expect((within(dlg).getByLabelText('目录路径') as HTMLInputElement).value).toBe('D:/cached');
    expect(vi.mocked(api.listFolderWorkflows)).not.toHaveBeenCalled();
  });

  it('对话框另存（改标记）：yaml 收到派生 tags、画布 tags 不变；成功后主按钮直存新路径（不再弹对话框）', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    vi.mocked(api.saveFolderWorkflow).mockResolvedValue({
      dir: 'D:/team/wf',
      file: 'derived.yaml',
      bytes: 99,
    });
    renderAt('/workflows/new', { importedYaml: ORIGIN_YAML }); // 无 origin → 走对话框
    await waitFor(() => expect(useEditorStore.getState().loaded).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: '另存到文件夹…' }));
    const dlg = screen.getByRole('dialog', { name: '保存到文件夹' });
    expect((within(dlg).getByLabelText('标记') as HTMLInputElement).value).toBe('演示'); // 初值=画布 tags join
    fireEvent.change(within(dlg).getByLabelText('目录路径'), { target: { value: 'D:/team/wf' } });
    fireEvent.change(within(dlg).getByLabelText('文件名'), { target: { value: 'derived.yaml' } });
    fireEvent.change(within(dlg).getByLabelText('标记'), { target: { value: ' 新组， extra ,,' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(vi.mocked(api.saveFolderWorkflow)).toHaveBeenCalledTimes(1));
    const arg = vi.mocked(api.saveFolderWorkflow).mock.calls[0][0];
    expect(arg.dir).toBe('D:/team/wf');
    expect(arg.file).toBe('derived.yaml');
    // yaml 为文档手术结果：切分 trim 去空后的新 tags 在、旧值不在
    expect(arg.yaml).toContain('- 新组');
    expect(arg.yaml).toContain('- extra');
    expect(arg.yaml).not.toContain('演示');
    // 画布 model 不动（文件派生、画布保持原 tags）
    expect(useEditorStore.getState().model!.tags).toEqual(['演示']);

    // 成功：对话框关闭 + toast + savedOrigin 生效 → 主按钮一键直达新路径
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '保存到文件夹' })).toBeNull());
    const toast = await screen.findByTestId('save-toast');
    expect(toast.textContent).toContain('已保存到 derived.yaml');
    expect(toast.textContent).toContain('✓');
    const main = screen.getByRole('button', { name: '保存到文件夹' }) as HTMLButtonElement;
    expect(main.title).toBe('D:/team/wf\\derived.yaml');

    vi.mocked(api.saveFolderWorkflow).mockClear();
    fireEvent.click(main);
    await waitFor(() => expect(vi.mocked(api.saveFolderWorkflow)).toHaveBeenCalledTimes(1));
    const arg2 = vi.mocked(api.saveFolderWorkflow).mock.calls[0][0];
    expect(arg2.dir).toBe('D:/team/wf');
    expect(arg2.file).toBe('derived.yaml');
    expect(arg2.yaml).toContain('- 演示'); // 直存回画布原文（画布 tags 未被派生改写）
    expect(screen.queryByRole('dialog')).toBeNull(); // 未再弹对话框
  });

  it('文件名缺 .yaml/.yml 后缀：保存时自动补 .yaml', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    vi.mocked(api.saveFolderWorkflow).mockResolvedValue({ dir: 'D:/x', file: 'plain.yaml', bytes: 9 });
    renderAt('/workflows/new');
    await waitFor(() => expect(useEditorStore.getState().loaded).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: '保存到文件夹' }));
    const dlg = screen.getByRole('dialog', { name: '保存到文件夹' });
    fireEvent.change(within(dlg).getByLabelText('目录路径'), { target: { value: 'D:/x' } });
    fireEvent.change(within(dlg).getByLabelText('文件名'), { target: { value: 'plain' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(vi.mocked(api.saveFolderWorkflow)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveFolderWorkflow).mock.calls[0][0].file).toBe('plain.yaml');
  });

  it('文件名含 /：预检拦截不发请求，错误就地显示且对话框保留', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    localStorage.setItem('fs-workflow-dir', 'D:/cached');
    renderAt('/workflows/new');
    await waitFor(() => expect(useEditorStore.getState().loaded).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: '保存到文件夹' }));
    const dlg = screen.getByRole('dialog', { name: '保存到文件夹' });
    fireEvent.change(within(dlg).getByLabelText('文件名'), { target: { value: 'a/b.yaml' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '保存' }));
    expect(vi.mocked(api.saveFolderWorkflow)).not.toHaveBeenCalled();
    within(dlg).getByText('文件名不能包含 / 或 \\');
    expect(screen.getByRole('dialog', { name: '保存到文件夹' })).toBeTruthy(); // 不关闭
  });

  it('服务端失败：对话框保留并就地显示错误', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    vi.mocked(api.saveFolderWorkflow).mockRejectedValueOnce(new Error('目录不存在'));
    localStorage.setItem('fs-workflow-dir', 'D:/cached');
    renderAt('/workflows/new');
    await waitFor(() => expect(useEditorStore.getState().loaded).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: '保存到文件夹' }));
    const dlg = screen.getByRole('dialog', { name: '保存到文件夹' });
    fireEvent.change(within(dlg).getByLabelText('文件名'), { target: { value: 'x.yaml' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '保存' }));
    const err = await within(dlg).findByText(/保存失败：目录不存在/);
    expect(err.className).toContain('fs-error-text');
    expect(screen.getByRole('dialog', { name: '保存到文件夹' })).toBeTruthy(); // 可改可取消
  });

  it('有 origin：点「另存到文件夹…」对话框预填 origin 目录/文件名与画布 tags', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    renderAt('/workflows/new', {
      importedYaml: ORIGIN_YAML,
      originDir: ORIGIN_DIR,
      originFile: ORIGIN_FILE,
    });
    await waitFor(() => expect(useEditorStore.getState().loaded).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: '另存到文件夹…' }));
    const dlg = screen.getByRole('dialog', { name: '保存到文件夹' });
    expect((within(dlg).getByLabelText('目录路径') as HTMLInputElement).value).toBe(ORIGIN_DIR);
    expect((within(dlg).getByLabelText('文件名') as HTMLInputElement).value).toBe(ORIGIN_FILE);
    expect((within(dlg).getByLabelText('标记') as HTMLInputElement).value).toBe('演示');
    expect(vi.mocked(api.listFolderWorkflows)).not.toHaveBeenCalled(); // 有 prefill 不取后端
  });

  it('有 origin（new 页）：主按钮一键直存（yaml 含 tags）→ toast 已保存到 <file> ✓', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    vi.mocked(api.saveFolderWorkflow).mockResolvedValue({
      dir: ORIGIN_DIR,
      file: ORIGIN_FILE,
      bytes: 120,
    });
    renderAt('/workflows/new', {
      importedYaml: ORIGIN_YAML,
      originDir: ORIGIN_DIR,
      originFile: ORIGIN_FILE,
    });

    const btn = (await screen.findByRole('button', { name: '保存到文件夹' })) as HTMLButtonElement;
    expect(btn.title).toBe(`${ORIGIN_DIR}\\${ORIGIN_FILE}`); // 目标路径
    await waitFor(() => expect(useEditorStore.getState().loaded).toBe(true));
    expect(btn.disabled).toBe(false); // 合法文档：可点

    fireEvent.click(btn);
    await waitFor(() => expect(vi.mocked(api.saveFolderWorkflow)).toHaveBeenCalledTimes(1));
    const arg = vi.mocked(api.saveFolderWorkflow).mock.calls[0][0];
    expect(arg.dir).toBe(ORIGIN_DIR);
    expect(arg.file).toBe(ORIGIN_FILE);
    expect(arg.yaml).toContain('name: origin-wf'); // 画布当前内容
    expect(arg.yaml).toContain('- 演示'); // tags 随 YAML 写回

    const toast = await screen.findByTestId('save-toast');
    expect(toast.textContent).toContain('已保存到 a.yaml');
    expect(toast.textContent).toContain('✓');
  });

  it('有 origin：校验问题禁用（同保存门，title 显示首条问题）；失败显示错误', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    vi.mocked(api.saveFolderWorkflow).mockRejectedValue(new Error('非法文件名'));
    renderAt('/workflows/new', {
      importedYaml: ORIGIN_YAML,
      originDir: ORIGIN_DIR,
      originFile: ORIGIN_FILE,
    });
    const btn = (await screen.findByRole('button', { name: '保存到文件夹' })) as HTMLButtonElement;
    await waitFor(() => expect(useEditorStore.getState().loaded).toBe(true));

    // 校验问题（meta.name 清空）→ 禁用 + title 为首条问题
    act(() => useEditorStore.getState().updateModelMeta({ name: '' }));
    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain('meta.name');
    expect(vi.mocked(api.saveFolderWorkflow)).not.toHaveBeenCalled();

    // 修复后可点；请求失败 → 就地错误文本（对话框未开，显在 fs-editor-msgs）
    act(() => useEditorStore.getState().updateModelMeta({ name: 'fixed' }));
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    const err = await screen.findByText(/保存到文件夹失败：非法文件名/);
    expect(err.className).toContain('fs-error-text');
  });
});

describe('WorkflowDetail：保存到文件夹等价手术（内容未变保留文件注释）', () => {
  const DIR = 'D:/team/wf';
  const FILE = '01-collect.yaml';
  // 与磁盘来源文件同文（含注释 + tags）——「在编辑器打开」导入后画布未动，
  // modelsEqualExceptTags 成立 → 直存应走文件原文通道而非 toYaml() 重排。
  const FILE_YAML = `# 团队注释：编辑器保存须保留（勿重排）
meta:
  name: origin-wf
  version: 3
  tags:
    - 演示
params: {}
nodes:
  - id: step1
    agent: mock
    prompt: from-folder
edges: []
`;

  /** mock 磁盘状态：来源目录里就是 FILE_YAML 本尊（valid、tags 演示）。 */
  const mockOriginFile = () =>
    vi.mocked(api.listFolderWorkflows).mockResolvedValue({
      dir: DIR,
      files: [
        {
          file: FILE,
          name: 'origin-wf',
          version: 3,
          valid: true,
          error: null,
          yaml: FILE_YAML,
          tags: ['演示'],
        },
      ],
    });

  it('origin 文件带注释、画布未动：直存 yaml === 文件原文（注释/排版一字不动）', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    mockOriginFile();
    vi.mocked(api.saveFolderWorkflow).mockResolvedValue({ dir: DIR, file: FILE, bytes: 1 });
    renderAt('/workflows/new', { importedYaml: FILE_YAML, originDir: DIR, originFile: FILE });
    await waitFor(() => expect(useEditorStore.getState().loaded).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: '保存到文件夹' }));
    await waitFor(() => expect(vi.mocked(api.saveFolderWorkflow)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.listFolderWorkflows)).toHaveBeenCalledWith(DIR); // 等价性检查读的是来源目录
    const arg = vi.mocked(api.saveFolderWorkflow).mock.calls[0][0];
    expect(arg.dir).toBe(DIR);
    expect(arg.file).toBe(FILE);
    expect(arg.yaml).toBe(FILE_YAML); // 原文整写：不是 toYaml() 的重排产物
  });

  it('画布只改 tags：直存收到手术原文（新 tags 在、旧 tags 不在、注释保留）', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    mockOriginFile();
    vi.mocked(api.saveFolderWorkflow).mockResolvedValue({ dir: DIR, file: FILE, bytes: 1 });
    renderAt('/workflows/new', { importedYaml: FILE_YAML, originDir: DIR, originFile: FILE });
    await waitFor(() => expect(useEditorStore.getState().loaded).toBe(true));

    act(() => useEditorStore.getState().updateModelMeta({ tags: ['新组'] })); // 只改 tags：内容等价仍成立
    fireEvent.click(screen.getByRole('button', { name: '保存到文件夹' }));
    await waitFor(() => expect(vi.mocked(api.saveFolderWorkflow)).toHaveBeenCalledTimes(1));
    const arg = vi.mocked(api.saveFolderWorkflow).mock.calls[0][0];
    expect(arg.yaml).toContain('# 团队注释：编辑器保存须保留（勿重排）'); // 手术在原文上
    expect(arg.yaml).toContain('- 新组');
    expect(arg.yaml).not.toContain('- 演示');
  });

  it('画布改了 prompt（内容已真变）：退回 toYaml() 全量序列化（注释不保留、tags 仍在）', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    mockOriginFile();
    vi.mocked(api.saveFolderWorkflow).mockResolvedValue({ dir: DIR, file: FILE, bytes: 1 });
    renderAt('/workflows/new', { importedYaml: FILE_YAML, originDir: DIR, originFile: FILE });
    await waitFor(() => expect(useEditorStore.getState().loaded).toBe(true));

    act(() => useEditorStore.getState().updateNode('step1', { prompt: 'changed' })); // 内容真变
    fireEvent.click(screen.getByRole('button', { name: '保存到文件夹' }));
    await waitFor(() => expect(vi.mocked(api.saveFolderWorkflow)).toHaveBeenCalledTimes(1));
    const arg = vi.mocked(api.saveFolderWorkflow).mock.calls[0][0];
    expect(arg.yaml).toContain('prompt: changed'); // 新内容在
    expect(arg.yaml).not.toContain('# 团队注释'); // 序列化重排：注释无从保留
    expect(arg.yaml).toContain('- 演示'); // 画布 tags 随序列化写回
  });

  it('无 origin 另存（标记未改）：yaml = toYaml() 序列化，且不做来源目录请求', async () => {
    vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
    localStorage.setItem('fs-workflow-dir', 'D:/cached');
    vi.mocked(api.saveFolderWorkflow).mockResolvedValue({ dir: 'D:/cached', file: 'x.yaml', bytes: 1 });
    renderAt('/workflows/new', { importedYaml: FILE_YAML }); // 无 origin → 无等价检查
    await waitFor(() => expect(useEditorStore.getState().loaded).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: '另存到文件夹…' }));
    const dlg = screen.getByRole('dialog', { name: '保存到文件夹' });
    fireEvent.change(within(dlg).getByLabelText('文件名'), { target: { value: 'x.yaml' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '保存' })); // 标记未动（= 演示）
    await waitFor(() => expect(vi.mocked(api.saveFolderWorkflow)).toHaveBeenCalledTimes(1));
    const arg = vi.mocked(api.saveFolderWorkflow).mock.calls[0][0];
    expect(arg.file).toBe('x.yaml');
    expect(arg.yaml).toContain('name: origin-wf'); // 序列化产物
    expect(arg.yaml).toContain('- 演示'); // 标记未改：无手术
    expect(arg.yaml).not.toContain('# 团队注释'); // 序列化天然不带注释（与原文通道的区别）
    expect(vi.mocked(api.listFolderWorkflows)).not.toHaveBeenCalled(); // localStorage 命中，无任何目录请求
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
