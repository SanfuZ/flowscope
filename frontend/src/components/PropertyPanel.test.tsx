// Task 5：属性面板三态表单测试。jsdom 直接渲染面板（无需 React Flow/画布），
// store 用真实 zustand 单例（getState 驱动 + afterEach 还原），api 客户端整体 mock
// （仅 listAgents 被面板消费）。所有表单字段经 label 关联断言（getByLabelText）。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { useEditorStore } from '../store/editorStore';
import PropertyPanel from './PropertyPanel';

vi.mock('../api/client', () => ({
  api: { listAgents: vi.fn() },
}));

const AGENTS = [{ key: 'mock', name: 'Mock', permission_default: 'ask', healthy: true }];

function renderPanel(problems: string[] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (p: string[]) => (
    <QueryClientProvider client={qc}>
      <PropertyPanel problems={p} />
    </QueryClientProvider>
  );
  const view = render(ui(problems));
  return { ...view, rerenderPanel: (p: string[]) => view.rerender(ui(p)) };
}

/** node 态渲染 + 冲刷微任务：让 useQuery 的 resolve 在 act 内落地，避免告警。 */
async function renderNodePanel() {
  vi.mocked(api.listAgents).mockResolvedValue(AGENTS);
  renderPanel();
  await act(async () => {});
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

describe('PropertyPanel：node 态', () => {
  it('prompt onChange 防抖 300ms 写回 store 并置 dirty', async () => {
    useEditorStore.getState().loadBlank();
    useEditorStore.getState().setSelection({ type: 'node', id: 'step1' });
    await renderNodePanel();
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'hello' } });
    expect(useEditorStore.getState().model!.nodes[0]!.prompt).toBe(''); // 防抖窗口内未提交
    await waitFor(() => expect(useEditorStore.getState().model!.nodes[0]!.prompt).toBe('hello'));
    expect(useEditorStore.getState().dirty).toBe(true);
  });

  it('prompt 失焦立即冲刷提交（绕过防抖：点画布即失焦，输入不丢；防抖已清除不二次提交）', async () => {
    vi.useFakeTimers();
    try {
      useEditorStore.getState().loadBlank();
      useEditorStore.getState().setSelection({ type: 'node', id: 'step1' });
      await renderNodePanel();
      const ta = screen.getByLabelText('Prompt') as HTMLTextAreaElement;
      fireEvent.change(ta, { target: { value: 'flush-me' } });
      expect(useEditorStore.getState().model!.nodes[0]!.prompt).toBe(''); // 仍在防抖窗口
      fireEvent.blur(ta); // 模拟点画布：失焦先于卸载
      expect(useEditorStore.getState().model!.nodes[0]!.prompt).toBe('flush-me'); // 失焦即写回
      expect(useEditorStore.getState().dirty).toBe(true);
      // 挂起的防抖已被冲刷清除：推进 300ms 不产生第二次 updateNode 效果
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(useEditorStore.getState().model!.nodes[0]!.prompt).toBe('flush-me');
      expect(useEditorStore.getState().past.length).toBe(1); // 历史仅一条（无重复提交）
    } finally {
      vi.useRealTimers();
    }
  });

  it('id 与其它节点重复：即时就地红字提示，失焦仍允许提交（保存门统一拦）', async () => {
    useEditorStore.getState().loadBlank();
    const b = useEditorStore.getState().addNode('mock'); // 自动选中 node-1
    expect(b).toBe('node-1');
    await renderNodePanel();
    const idInput = screen.getByLabelText('节点 ID') as HTMLInputElement;
    expect(idInput.value).toBe('node-1');
    fireEvent.change(idInput, { target: { value: 'step1' } });
    screen.getByText(/与其它节点重复/); // 未失焦即提示
    fireEvent.blur(idInput);
    const ids = useEditorStore.getState().model!.nodes.map((n) => n.id);
    expect(ids.filter((x) => x === 'step1').length).toBe(2); // 仍提交进 store
  });

  it('output_schema 非法 JSON：不提交、红框 + 就地错误', async () => {
    useEditorStore.getState().loadBlank();
    useEditorStore.getState().setSelection({ type: 'node', id: 'step1' });
    await renderNodePanel();
    const ta = screen.getByLabelText('输出 Schema (JSON)') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '{bad json' } });
    fireEvent.blur(ta);
    expect(useEditorStore.getState().model!.nodes[0]!.output_schema).toBeUndefined();
    expect(useEditorStore.getState().dirty).toBe(false); // 未写 store
    expect(ta.className).toContain('fs-form-input--error');
    screen.getByText(/JSON 解析失败/);
  });
});

describe('PropertyPanel：edge 态', () => {
  it('条件三件套拼出 when 表达式（brief 用例：output.ok == true）', () => {
    useEditorStore.getState().loadBlank();
    const b = useEditorStore.getState().addNode('mock');
    useEditorStore.getState().connect('step1', b);
    useEditorStore.getState().setSelection({ type: 'edge', id: `step1->${b}` });
    renderPanel();
    fireEvent.change(screen.getByLabelText('字段路径'), { target: { value: 'output.ok' } });
    fireEvent.change(screen.getByLabelText('值'), { target: { value: 'true' } });
    const m = useEditorStore.getState().model!;
    expect(m.edges[0]!.when).toBe('output.ok == true');
    expect(useEditorStore.getState().dirty).toBe(true);
  });

  it('已有 when 回填三件套；「清除条件」置回无条件边', () => {
    useEditorStore.getState().loadBlank();
    const b = useEditorStore.getState().addNode('mock');
    useEditorStore.getState().connect('step1', b);
    useEditorStore.getState().updateEdge('step1', b, { when: 'output.ok == true' });
    useEditorStore.getState().setSelection({ type: 'edge', id: `step1->${b}` });
    renderPanel();
    expect((screen.getByLabelText('字段路径') as HTMLInputElement).value).toBe('output.ok');
    expect((screen.getByLabelText('值') as HTMLInputElement).value).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '清除条件' }));
    expect(useEditorStore.getState().model!.edges[0]!.when).toBeUndefined();
  });

  it('raw when 表达式失焦提交并回填三件套；非法时红框不动 store', () => {
    useEditorStore.getState().loadBlank();
    const b = useEditorStore.getState().addNode('mock');
    useEditorStore.getState().connect('step1', b);
    useEditorStore.getState().setSelection({ type: 'edge', id: `step1->${b}` });
    renderPanel();
    const raw = screen.getByLabelText('when 表达式') as HTMLTextAreaElement;
    fireEvent.change(raw, { target: { value: 'output.n == 42' } });
    fireEvent.blur(raw);
    expect(useEditorStore.getState().model!.edges[0]!.when).toBe('output.n == 42');
    // 回填三件套
    expect((screen.getByLabelText('字段路径') as HTMLInputElement).value).toBe('output.n');
    expect((screen.getByLabelText('值') as HTMLInputElement).value).toBe('42');
    // 非法：红框 + 就地错误，store 不动
    fireEvent.change(raw, { target: { value: 'nonsense' } });
    fireEvent.blur(raw);
    expect(useEditorStore.getState().model!.edges[0]!.when).toBe('output.n == 42');
    expect(raw.className).toContain('fs-form-input--error');
    screen.getByText(/无法解析条件/);
  });
});

describe('PropertyPanel：settings 态', () => {
  it('params 增删行写回（字符串/整数标量解析，失焦整体提交）', () => {
    useEditorStore.getState().loadBlank(); // selected=null → settings 态
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '添加参数' }));
    const key0 = screen.getByLabelText('参数名') as HTMLInputElement;
    fireEvent.change(key0, { target: { value: 'env' } });
    fireEvent.change(screen.getByLabelText('参数值') as HTMLInputElement, { target: { value: 'prod' } });
    fireEvent.blur(key0);
    expect(useEditorStore.getState().model!.params).toEqual({ env: 'prod' });

    fireEvent.click(screen.getByRole('button', { name: '添加参数' }));
    const keys = screen.getAllByLabelText('参数名') as HTMLInputElement[];
    const vals = screen.getAllByLabelText('参数值') as HTMLInputElement[];
    fireEvent.change(keys[1]!, { target: { value: 'n' } });
    fireEvent.change(vals[1]!, { target: { value: '3' } });
    fireEvent.blur(keys[1]!);
    expect(useEditorStore.getState().model!.params).toEqual({ env: 'prod', n: 3 }); // 整数→number

    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0]!);
    expect(useEditorStore.getState().model!.params).toEqual({ n: 3 });
  });

  it('name 失焦经 updateModelMeta 写回顶层 meta', () => {
    useEditorStore.getState().loadBlank();
    renderPanel();
    const name = screen.getByLabelText('名称') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'renamed' } });
    fireEvent.blur(name);
    expect(useEditorStore.getState().model!.name).toBe('renamed');
    expect(useEditorStore.getState().dirty).toBe(true);
  });

  it('新节点默认（T2）：失焦经 updateNodeDefaults 提交偏好，不进历史、不置脏', () => {
    useEditorStore.getState().loadBlank();
    useEditorStore.getState().updateNodeDefaults({ retryMax: 2, backoffMs: 3000, timeoutMs: 600000 });
    useEditorStore.getState().markSaved();
    renderPanel();

    // 草稿回填自 store 现值
    const retry = screen.getByLabelText('新节点重试次数') as HTMLInputElement;
    const backoff = screen.getByLabelText('新节点重试退避(ms)') as HTMLInputElement;
    const timeout = screen.getByLabelText('新节点超时(ms)') as HTMLInputElement;
    expect(retry.value).toBe('2');
    expect(backoff.value).toBe('3000');
    expect(timeout.value).toBe('600000');

    // 失焦提交：写偏好，不动文档（dirty=false、无历史）
    fireEvent.change(retry, { target: { value: '5' } });
    fireEvent.blur(retry);
    fireEvent.change(timeout, { target: { value: '0' } }); // 0=不限时，合法
    fireEvent.blur(timeout);
    const s = useEditorStore.getState();
    expect(s.newNodeDefaults).toEqual({ retryMax: 5, backoffMs: 3000, timeoutMs: 0 });
    expect(s.dirty).toBe(false);
    expect(s.past).toEqual([]);

    // 空串 = 放弃编辑，保留现值；负数/非数字不提交
    fireEvent.change(retry, { target: { value: '' } });
    fireEvent.blur(retry);
    expect(useEditorStore.getState().newNodeDefaults.retryMax).toBe(5);
    fireEvent.change(retry, { target: { value: '-1' } });
    fireEvent.blur(retry);
    expect(useEditorStore.getState().newNodeDefaults.retryMax).toBe(5);

    // 不改已存在节点：文档内 step1 仍无 retry/timeout（播种只发生在 addNode）
    expect(useEditorStore.getState().model!.nodes[0]).toEqual({
      id: 'step1',
      agent: 'mock',
      prompt: '',
    });
  });
});

describe('PropertyPanel：底部公共校验区', () => {
  it('problems 逐条红字；空数组显示 ✓ 校验通过', () => {
    useEditorStore.getState().loadBlank();
    const view = renderPanel(['重复节点 id: step1', 'meta.name 不能为空']);
    screen.getByText('重复节点 id: step1');
    screen.getByText('meta.name 不能为空');
    view.rerenderPanel([]);
    screen.getByText('✓ 校验通过');
  });
});
