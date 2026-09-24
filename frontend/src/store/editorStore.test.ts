// Task 3：编辑器 store（快照式撤销重做 / 级联编辑 / YAML 往返）。
// 约定：直接经 useEditorStore.getState() 驱动动作，每用例从 loadBlank() 起步，
// 避免用例间共享残留状态（zustand 模块级单例）。
import { describe, expect, it } from 'vitest';
import { serializeWorkflowYaml } from '../api/workflowModel';
import { useEditorStore } from './editorStore';

const S = () => useEditorStore.getState();

describe('loadYaml / loadBlank：文档装载', () => {
  it('loadYaml 解析成功：loaded=true、重置历史/dirty/parseErrors/selected', () => {
    S().loadBlank();
    S().addNode('mock'); // 制造 dirty 与历史
    const yaml = [
      'meta:',
      '  name: demo',
      'params:',
      '  k: v',
      'nodes:',
      '  - id: a',
      '    agent: mock',
      '    prompt: hello',
      'edges: []',
    ].join('\n');
    S().loadYaml(yaml);
    const s = S();
    expect(s.loaded).toBe(true);
    expect(s.model!.name).toBe('demo');
    expect(s.model!.nodes).toEqual([{ id: 'a', agent: 'mock', prompt: 'hello' }]);
    expect(s.dirty).toBe(false);
    expect(s.past).toEqual([]);
    expect(s.future).toEqual([]);
    expect(s.parseErrors).toEqual([]);
    expect(s.selected).toBeNull();
  });

  it('loadYaml 解析失败：保留原有状态，仅记 parseErrors', () => {
    S().loadBlank();
    S().addNode('mock');
    const snapshotBefore = S().model;
    S().loadYaml('nodes: 5'); // nodes 必须为数组 → 结构错误
    const s = S();
    expect(s.parseErrors.length).toBeGreaterThan(0);
    expect(s.model).toBe(snapshotBefore); // 原文档原样保留（引用未换）
    expect(s.loaded).toBe(true);
    expect(s.dirty).toBe(true); // 之前 addNode 的 dirty 不被失败加载冲掉
    // 后续成功加载清空 parseErrors
    S().loadYaml(serializeWorkflowYaml({ name: 'ok', version: 1, params: {}, nodes: [], edges: [] }));
    expect(S().parseErrors).toEqual([]);
  });

  it('loadBlank：step1 起始文档 + 初始位置，重置历史与 dirty', () => {
    S().loadBlank();
    const s = S();
    expect(s.loaded).toBe(true);
    expect(s.model).toEqual({
      name: 'my-workflow',
      version: 1,
      params: {},
      nodes: [{ id: 'step1', agent: 'mock', prompt: '' }],
      edges: [],
    });
    expect(s.positions).toEqual({ step1: { x: 80, y: 120 } });
    expect(s.dirty).toBe(false);
    expect(s.past).toEqual([]);
    expect(s.future).toEqual([]);
    expect(s.parseErrors).toEqual([]);
  });
});

describe('addNode / updateNode / removeNode：节点级编辑', () => {
  it('addNode 自增 id 避撞，默认内容 {id, agent, prompt: ""}，默认位置级联，选中新节点', () => {
    S().loadBlank();
    const a = S().addNode('mock');
    expect(a).toBe('node-1');
    const b = S().addNode('llm');
    expect(b).toBe('node-2');
    const s = S();
    const added = s.model!.nodes.find((n) => n.id === 'node-1')!;
    expect(added).toEqual({ id: 'node-1', agent: 'mock', prompt: '' });
    // 默认位置视觉级联：loadBlank 后已有 1 节点 → count=1 → {x: 80+40*1, y: 80}
    expect(s.positions['node-1']).toEqual({ x: 120, y: 80 });
    expect(s.positions['node-2']).toEqual({ x: 160, y: 80 });
    expect(s.selected).toEqual({ type: 'node', id: 'node-2' });
    expect(s.dirty).toBe(true);
  });

  it('addNode 指定 pos 优先；id 与既有节点撞号时跳过（node-1 被占 → node-2）', () => {
    S().loadBlank();
    S().addNode('mock', { x: 10, y: 20 });
    expect(S().positions['node-1']).toEqual({ x: 10, y: 20 });
    // 载入已含 node-1 的文档后再加节点：应避撞生成 node-2
    S().loadYaml(
      serializeWorkflowYaml({
        name: 'd',
        version: 1,
        params: {},
        nodes: [{ id: 'node-1', agent: 'mock', prompt: '' }],
        edges: [],
      }),
    );
    const id = S().addNode('mock');
    expect(id).toBe('node-2');
  });

  it('updateNode 普通补丁合并字段（prompt/retry/timeout_ms）', () => {
    S().loadBlank();
    S().updateNode('step1', { prompt: 'p', retry: { max: 2, backoff_ms: 100 }, timeout_ms: 5000 });
    const n = S().model!.nodes[0];
    expect(n).toEqual({
      id: 'step1',
      agent: 'mock',
      prompt: 'p',
      retry: { max: 2, backoff_ms: 100 },
      timeout_ms: 5000,
    });
  });

  it('改节点 id 同步重构边与位置', () => {
    const s = S();
    s.loadBlank();
    const b = s.addNode('mock');
    s.connect('step1', b);
    s.updateNode('step1', { id: 'collect' });
    const m = useEditorStore.getState().model!;
    expect(m.nodes.some((n) => n.id === 'collect')).toBe(true);
    expect(m.edges).toEqual([{ from: 'collect', to: b }]);
    expect(useEditorStore.getState().positions['collect']).toBeDefined();
    expect(useEditorStore.getState().positions['step1']).toBeUndefined();
  });

  it('改 id 撞上既有节点仍应用（store 宽松，校验层负责报错）', () => {
    S().loadBlank();
    const b = S().addNode('mock');
    S().updateNode('step1', { id: b }); // 与 node-1 撞号：仍执行
    const ids = S().model!.nodes.map((n) => n.id);
    expect(ids.filter((x) => x === b).length).toBe(2);
  });

  it('removeNode 级联删除关联边与位置', () => {
    S().loadBlank();
    const b = S().addNode('mock');
    const c = S().addNode('mock');
    S().connect('step1', b);
    S().connect(b, c);
    S().removeNode(b);
    const s = S();
    expect(s.model!.nodes.map((n) => n.id)).toEqual(['step1', c]);
    expect(s.model!.edges).toEqual([]); // step1→b 与 b→c 均随节点删除
    expect(s.positions[b]).toBeUndefined();
  });
});

describe('connect / updateEdge / removeEdge：边级编辑', () => {
  it('connect 去重同向边；自环允许存入（校验层报环）', () => {
    S().loadBlank();
    const b = S().addNode('mock');
    S().connect('step1', b);
    S().connect('step1', b); // 重复：忽略
    S().connect(b, b); // 自环：允许
    expect(S().model!.edges).toEqual([
      { from: 'step1', to: b },
      { from: b, to: b },
    ]);
  });

  it('updateEdge 按 (from,to) 定位补丁；removeEdge 删除', () => {
    S().loadBlank();
    const b = S().addNode('mock');
    const c = S().addNode('mock');
    S().connect('step1', b);
    S().connect('step1', c);
    S().updateEdge('step1', b, { when: 'params.ok == true' });
    const edges = S().model!.edges;
    expect(edges.find((e) => e.to === b)).toEqual({ from: 'step1', to: b, when: 'params.ok == true' });
    expect(edges.find((e) => e.to === c)).toEqual({ from: 'step1', to: c }); // 不受影响
    S().removeEdge('step1', b);
    expect(S().model!.edges).toEqual([{ from: 'step1', to: c }]);
  });
});

describe('undo / redo：快照历史', () => {
  it('add→undo 复原（模型与位置）→redo 恢复', () => {
    useEditorStore.getState().loadBlank();
    useEditorStore.getState().addNode('mock');
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().model!.nodes.length).toBe(1);
    expect(useEditorStore.getState().positions['node-1']).toBeUndefined();
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().model!.nodes.length).toBe(2);
    expect(useEditorStore.getState().positions['node-1']).toEqual({ x: 120, y: 80 });
  });

  it('undo 复原 removeNode 的级联（节点/边/位置一并回来）', () => {
    S().loadBlank();
    const b = S().addNode('mock');
    S().connect('step1', b);
    S().removeNode(b);
    expect(S().model!.nodes.length).toBe(1);
    S().undo();
    const s = S();
    expect(s.model!.nodes.map((n) => n.id)).toEqual(['step1', b]);
    expect(s.model!.edges).toEqual([{ from: 'step1', to: b }]);
    expect(s.positions[b]).toEqual({ x: 120, y: 80 });
  });

  it('新变更清空 future：undo 后再编辑则 redo 失效', () => {
    S().loadBlank();
    S().addNode('mock');
    S().undo();
    expect(S().future.length).toBe(1);
    S().addNode('llm'); // 分叉：future 必须清空
    expect(S().future).toEqual([]);
    S().redo(); // 无可 redo
    expect(S().model!.nodes.map((n) => n.id)).toEqual(['step1', 'node-1']);
  });

  it('历史上限 50：第 51 条挤出最旧快照', () => {
    S().loadBlank();
    for (let i = 0; i < 55; i++) S().addNode('mock');
    expect(S().past.length).toBe(50);
    S().undo();
    expect(S().model!.nodes.length).toBe(55); // 撤销最近一次 addNode
    S().undo();
    S().undo();
    expect(S().model!.nodes.length).toBe(53);
    // 只能再撤 47 次（50-3 已用）：第 48 次 undo 为 no-op
    for (let i = 0; i < 47; i++) S().undo();
    expect(S().model!.nodes.length).toBe(6); // 55-49=6：最早 6 个节点不可复原
    S().undo();
    expect(S().model!.nodes.length).toBe(6);
  });

  it('undo/redo 空历史为 no-op（不抛错）', () => {
    S().loadBlank();
    expect(() => {
      S().undo();
      S().redo();
    }).not.toThrow();
    expect(S().model!.nodes.length).toBe(1);
  });
});

describe('setPositions / setSelection / markSaved：视图态', () => {
  it('setPositions 批量写位置：不进 history、不动 dirty', () => {
    S().loadBlank();
    S().addNode('mock');
    S().markSaved();
    const pastBefore = S().past.length;
    S().setPositions({ step1: { x: 1, y: 2 }, 'node-1': { x: 3, y: 4 } });
    const s = S();
    expect(s.positions).toEqual({ step1: { x: 1, y: 2 }, 'node-1': { x: 3, y: 4 } });
    expect(s.past.length).toBe(pastBefore); // 未新增历史
    expect(s.dirty).toBe(false); // 位置是视图态，不影响 dirty
    S().undo(); // 撤销仍指向 addNode 前的快照（位置随之复原）
    expect(S().model!.nodes.length).toBe(1);
  });

  it('setSelection 不进 history、不改 dirty；markSaved 置 dirty=false', () => {
    S().loadBlank();
    S().addNode('mock');
    expect(S().dirty).toBe(true);
    const pastBefore = S().past.length;
    S().setSelection({ type: 'settings' });
    expect(S().selected).toEqual({ type: 'settings' });
    expect(S().past.length).toBe(pastBefore);
    expect(S().dirty).toBe(true);
    S().markSaved();
    expect(S().dirty).toBe(false);
  });
});

describe('updateModelMeta：顶层元信息编辑（Task 5，属性面板 settings 态）', () => {
  it('合并 name/version/params/on_node_failure 并置 dirty', () => {
    S().loadBlank();
    S().updateModelMeta({
      name: 'demo',
      version: 2,
      params: { env: 'prod', n: 3, ok: true },
      on_node_failure: 'continue_independent',
    });
    const s = S();
    expect(s.model!.name).toBe('demo');
    expect(s.model!.version).toBe(2);
    expect(s.model!.params).toEqual({ env: 'prod', n: 3, ok: true });
    expect(s.model!.on_node_failure).toBe('continue_independent');
    expect(s.dirty).toBe(true);
  });

  it('局部补丁不动其它字段（nodes/params 原样），且进历史可撤销', () => {
    S().loadBlank();
    S().updateNode('step1', { prompt: 'p' });
    S().updateModelMeta({ name: 'renamed' });
    const m = S().model!;
    expect(m.version).toBe(1);
    expect(m.params).toEqual({});
    expect(m.nodes).toEqual([{ id: 'step1', agent: 'mock', prompt: 'p' }]);
    S().undo();
    expect(S().model!.name).toBe('my-workflow');
    expect(S().model!.nodes[0]!.prompt).toBe('p'); // undo 只回退元信息变更
    S().redo();
    expect(S().model!.name).toBe('renamed');
  });

  it('model 为空时 no-op（不抛错）', () => {
    useEditorStore.setState({ model: null, loaded: false });
    expect(() => S().updateModelMeta({ name: 'x' })).not.toThrow();
    expect(S().model).toBeNull();
  });
});

describe('toYaml：与 loadYaml 往返', () => {
  it('toYaml → loadYaml 往返', () => {
    useEditorStore.getState().loadBlank();
    const n = useEditorStore.getState().addNode('mock');
    useEditorStore.getState().updateNode(n, { prompt: 'p2', retry: { max: 1, backoff_ms: 500 } });
    const yaml = useEditorStore.getState().toYaml();
    useEditorStore.getState().loadYaml(yaml);
    expect(useEditorStore.getState().model!.nodes.find((x) => x.id === n)?.retry).toEqual({ max: 1, backoff_ms: 500 });
  });

  it('model 为空时 toYaml 返回空串', () => {
    useEditorStore.setState({ model: null });
    expect(useEditorStore.getState().toYaml()).toBe('');
  });
});
