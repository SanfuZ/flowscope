// 画布编辑器文档 store：WorkflowModel 为唯一文档事实源，positions 为并行的
// 视图态（不序列化、不进 dirty）。快照式撤销重做：每次变更前把
// {model 深拷贝, positions 浅拷贝} 压入 past（上限 50，超出挤最旧），
// 任何变更清空 future。设计取舍：
//   - store 宽松：id 撞号/自环/悬空引用照样存入，合法性归 lib/validate.ts
//     （与 api/workflowModel.ts 只管结构校验同一分层原则）；
//   - setPositions/setSelection/markSaved 不进历史；setPositions 不动
//     dirty（位置非文档内容，保存的 YAML 不含它）；updateNodeDefaults
//     同层——新节点默认偏好（非文档内容），不进历史、不置脏、loadYaml/
//     loadBlank 不重置，仅 addNode 播种时读取；
//   - loadYaml 失败保留旧文档仅记 parseErrors，成功则整体重置（新文档）。
import { create } from 'zustand';
import { parseWorkflowModel, serializeWorkflowYaml } from '../api/workflowModel';
import type { EdgeModel, NodeModel, WorkflowModel } from '../api/workflowModel';

export interface EditorSnapshot {
  model: WorkflowModel;
  positions: Record<string, { x: number; y: number }>;
}

/** 新节点默认偏好（编辑器偏好而非文档内容）：addNode 播种 retry/timeout 用。 */
export interface NewNodeDefaults {
  retryMax: number;
  backoffMs: number;
  timeoutMs: number;
}

/** 新节点默认值（语义：0=不重试 / 0=不限时——addNode 据此省略字段）。 */
export const DEFAULT_NEW_NODE_DEFAULTS: NewNodeDefaults = {
  retryMax: 2,
  backoffMs: 3000,
  timeoutMs: 600000,
};

export interface EditorState {
  loaded: boolean; // 是否已载入文档（new 或既有）
  model: WorkflowModel | null;
  positions: Record<string, { x: number; y: number }>;
  selected: { type: 'node' | 'edge' | 'settings'; id?: string } | null;
  dirty: boolean;
  past: EditorSnapshot[];
  future: EditorSnapshot[]; // 上限各 50
  parseErrors: string[];
  /** 新节点默认偏好（工作流设置里调）：addNode 播种 retry/timeout 用。
   *  编辑器偏好而非文档内容——不进历史、不置脏，loadYaml/loadBlank 不重置。 */
  newNodeDefaults: NewNodeDefaults;
  updateNodeDefaults(patch: Partial<NewNodeDefaults>): void;
  loadYaml(yaml: string): void; // parseWorkflowModel 失败则 loaded 保持 false 并存 parseErrors
  loadBlank(): void; // {name:'my-workflow', version:1, 单节点 step1 agent 'mock'}
  addNode(agent: string, pos?: { x: number; y: number }): string; // 返回新 id（node-1 递增避撞）
  updateNode(id: string, patch: Partial<NodeModel>): void; // id 变更时同步改 positions 键与 edges 引用
  removeNode(id: string): void; // 级联删除关联边
  connect(from: string, to: string): void; // 已存在同向边则忽略；自环允许存入（校验层报环）
  updateEdge(from: string, to: string, patch: Partial<EdgeModel>): void;
  removeEdge(from: string, to: string): void;
  /** 顶层元信息编辑（属性面板 settings 态）：name/version/tags/params/
   *  on_node_failure，与节点/边编辑同纪律（进 history、置 dirty）；
   *  tags 传 undefined = 删除字段。 */
  updateModelMeta(patch: Partial<Pick<WorkflowModel, 'name' | 'version' | 'tags' | 'params' | 'on_node_failure'>>): void;
  setPositions(next: Record<string, { x: number; y: number }>): void; // 拖拽结束批量写，不进 history
  setSelection(sel: EditorState['selected']): void; // 不进 history、不改 dirty
  markSaved(): void; // dirty=false
  undo(): void;
  redo(): void;
  toYaml(): string; // model 为空返回 ''
}

/** 历史栈上限（past/future 各自截断）。 */
const HISTORY_CAP = 50;

/** zustand 5 下 useEditorStore 的类型为 UseBoundStore<StoreApi<EditorState>>，
 *  由 create<EditorState>() 推得（简报中 UseBoundStore<EditorState> 的注解写法
 *  不满足其泛型约束，故省略显式注解、交给推断）。 */
export const useEditorStore = create<EditorState>()((set, get) => {
    /** 变更前调用：把当前 {model 深拷贝, positions 浅拷贝} 压入 past、清 future、
     *  截断至 50。返回并入 set() 的局部状态（须在变更发生前求值）。 */
    const pushHistory = (): Partial<EditorState> => {
      const { model, positions, past } = get();
      if (!model) return {};
      const snap: EditorSnapshot = { model: structuredClone(model), positions: { ...positions } };
      const nextPast = past.length >= HISTORY_CAP ? [...past.slice(1), snap] : [...past, snap];
      return { past: nextPast, future: [] };
    };

    /** 生成不撞号的节点 id：node-<n> 从 1 起递增直到未占用。 */
    const nextNodeId = (model: WorkflowModel): string => {
      const used = new Set(model.nodes.map((n) => n.id));
      let n = 1;
      while (used.has(`node-${n}`)) n++;
      return `node-${n}`;
    };

    return {
      loaded: false,
      model: null,
      positions: {},
      selected: null,
      dirty: false,
      past: [],
      future: [],
      parseErrors: [],
      newNodeDefaults: { ...DEFAULT_NEW_NODE_DEFAULTS },

      // 编辑器偏好：整体浅合并，不进历史、不置脏（与 setPositions/setSelection 同层）
      updateNodeDefaults: (patch) => {
        set({ newNodeDefaults: { ...get().newNodeDefaults, ...patch } });
      },

      loadYaml: (yaml) => {
        const { model, errors } = parseWorkflowModel(yaml);
        if (!model) {
          // 失败：保留旧文档与历史，仅记错误（loaded 维持原值——从未装载过则仍为 false）
          set({ parseErrors: errors });
          return;
        }
        // 成功：整体重置为新文档（positions 随后由画布自动布局/setPositions 填充）
        set({
          loaded: true,
          model,
          positions: {},
          selected: null,
          dirty: false,
          past: [],
          future: [],
          parseErrors: [],
        });
      },

      loadBlank: () => {
        set({
          loaded: true,
          model: {
            name: 'my-workflow',
            version: 1,
            params: {},
            nodes: [{ id: 'step1', agent: 'mock', prompt: '' }],
            edges: [],
          },
          positions: { step1: { x: 80, y: 120 } },
          selected: null,
          dirty: false,
          past: [],
          future: [],
          parseErrors: [],
        });
      },

      addNode: (agent, pos) => {
        const { model, positions } = get();
        if (!model) return '';
        const id = nextNodeId(model);
        // 默认位置：视觉级联（每行 4 个，横向错位 40、纵向步进 120）
        const p = pos ?? {
          x: 80 + 40 * (model.nodes.length % 4),
          y: 80 + 120 * Math.floor(model.nodes.length / 4),
        };
        // 按偏好播种 retry/timeout：0 省略字段（0=不重试/不限时），不写半成品的
        // retry: {max: 0}——YAML 层 retry/timeout 本就是可省字段（后端 serde 权威）
        const d = get().newNodeDefaults;
        const seed: Partial<NodeModel> = {};
        if (d.retryMax > 0) seed.retry = { max: d.retryMax, backoff_ms: d.backoffMs };
        if (d.timeoutMs > 0) seed.timeout_ms = d.timeoutMs;
        const history = pushHistory();
        set({
          ...history,
          model: { ...model, nodes: [...model.nodes, { id, agent, prompt: '', ...seed }] },
          positions: { ...positions, [id]: p },
          selected: { type: 'node', id },
          dirty: true,
        });
        return id;
      },

      updateNode: (id, patch) => {
        const { model, positions } = get();
        if (!model) return;
        const idx = model.nodes.findIndex((n) => n.id === id);
        if (idx < 0) return;
        const renamed = patch.id !== undefined && patch.id !== id ? patch.id : null;
        const nodes = model.nodes.map((n, i) => (i === idx ? { ...n, ...patch } : n));
        // 改 id：同步重写边引用（仅该节点关联的 from/to）
        const edges = renamed
          ? model.edges.map((e) => ({
              ...e,
              ...(e.from === id ? { from: renamed } : {}),
              ...(e.to === id ? { to: renamed } : {}),
            }))
          : model.edges;
        // 改 id：迁移 positions 键（撞号也照常应用——校验层负责报错）
        let nextPositions = positions;
        if (renamed) {
          nextPositions = { ...positions };
          if (nextPositions[id] !== undefined) {
            const v = nextPositions[id];
            delete nextPositions[id];
            nextPositions[renamed] = v;
          }
        }
        const history = pushHistory();
        set({ ...history, model: { ...model, nodes, edges }, positions: nextPositions, dirty: true });
      },

      removeNode: (id) => {
        const { model, positions } = get();
        if (!model) return;
        const nodes = model.nodes.filter((n) => n.id !== id);
        const edges = model.edges.filter((e) => e.from !== id && e.to !== id);
        const nextPositions = { ...positions };
        delete nextPositions[id];
        const history = pushHistory();
        set({ ...history, model: { ...model, nodes, edges }, positions: nextPositions, dirty: true });
      },

      connect: (from, to) => {
        const { model } = get();
        if (!model) return;
        // 同向边去重；自环允许存入（环检测归校验层）
        if (model.edges.some((e) => e.from === from && e.to === to)) return;
        const history = pushHistory();
        set({ ...history, model: { ...model, edges: [...model.edges, { from, to }] }, dirty: true });
      },

      updateEdge: (from, to, patch) => {
        const { model } = get();
        if (!model) return;
        const idx = model.edges.findIndex((e) => e.from === from && e.to === to);
        if (idx < 0) return;
        const edges = model.edges.map((e, i) => (i === idx ? { ...e, ...patch } : e));
        const history = pushHistory();
        set({ ...history, model: { ...model, edges }, dirty: true });
      },

      removeEdge: (from, to) => {
        const { model } = get();
        if (!model) return;
        const edges = model.edges.filter((e) => !(e.from === from && e.to === to));
        if (edges.length === model.edges.length) return;
        const history = pushHistory();
        set({ ...history, model: { ...model, edges }, dirty: true });
      },

      updateModelMeta: (patch) => {
        const { model } = get();
        if (!model) return;
        const history = pushHistory();
        set({ ...history, model: { ...model, ...patch }, dirty: true });
      },

      setPositions: (next) => {
        set({ positions: next }); // 批量整体替换；不进 history、不动 dirty
      },

      setSelection: (sel) => {
        set({ selected: sel });
      },

      markSaved: () => {
        set({ dirty: false });
      },

      undo: () => {
        const { model, positions, past, future } = get();
        if (past.length === 0) return;
        const snap = past[past.length - 1];
        // 当前态克隆入 future（同样截断 50）
        const nextFuture =
          model == null
            ? future
            : future.length >= HISTORY_CAP
              ? [...future.slice(1), { model: structuredClone(model), positions: { ...positions } }]
              : [...future, { model: structuredClone(model), positions: { ...positions } }];
        set({
          past: past.slice(0, -1),
          future: nextFuture,
          model: snap.model,
          positions: { ...snap.positions },
        });
      },

      redo: () => {
        const { model, positions, past, future } = get();
        if (future.length === 0) return;
        const snap = future[future.length - 1];
        // 当前态克隆入 past（同样截断 50）
        let nextPast = past;
        if (model != null) {
          nextPast = [...past, { model: structuredClone(model), positions: { ...positions } }];
          if (nextPast.length > HISTORY_CAP) nextPast = nextPast.slice(1);
        }
        set({
          past: nextPast,
          future: future.slice(0, -1),
          model: snap.model,
          positions: { ...snap.positions },
        });
      },

      toYaml: () => {
        const { model } = get();
        return model ? serializeWorkflowYaml(model) : '';
      },
    };
  });
