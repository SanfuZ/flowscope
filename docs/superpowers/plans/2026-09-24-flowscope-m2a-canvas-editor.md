# FlowScope M2a（画布图形编辑器）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 工作流的结构与属性全部在画布上以图形方式创建和修改（拖入节点、拉线连边、属性面板填写），YAML 退居存储/交换格式（可随时切换查看/导入），含撤销重做与前端校验。

**Architecture:** 前端三层——`WorkflowModel` 文档模型（编辑器唯一事实源，zustand store 管理，快照式撤销重做）；`EditableCanvas`（React Flow 可编辑画布 + 节点面板）；`PropertyPanel`（节点/边/工作流三态表单）。YAML 解析/序列化换成 `yaml` npm 包（替换 M1 的脆弱行扫描器 graph.ts），保存仍走既有 POST /api/workflows（后端零改动）。

**Tech Stack:** 既有 React 18/Vite 6/TS 栈；新增唯一依赖 `yaml@^2`（parse + stringify）；复用 @xyflow/react 12、zustand 5、@tanstack/react-query 5。

**Spec:** `docs/superpowers/specs/2026-09-22-flowscope-design.md` §7.1 视图 4（M2 部分：节点面板拖入、连线把手拖拽建边/删边、内联属性面板、条件边表单化、撤销重做、YAML 双向）+ §4.1 DSL 字段定义。

## Global Constraints

- 唯一新增 npm 依赖：`yaml@^2`；不得引入任何 UI 组件库/图标库/tailwind。
- 既有 e2e 选择器必须存活：`.fs-card`（WorkflowList）、按钮文本「启动运行」「新建工作流」（WorkflowList/WorkflowDetail）、`data-testid="node-card"`、`.fs-node--<status>`、`.fs-monitor`、`drawer-*` testid、tab role 名（消息/工具/Plan/日志/输入输出）。
- `run.spec.ts`（既有 e2e）全程不得改动且必须保持 2/2 通过。
- UI 文案全部中文；样式沿用深色主题 CSS 变量（`frontend/src/styles.css` `:root`），新样式写入同文件并复用变量。
- YAML 往返语义（spec §7.1）：从 YAML 导入无损渲染；图形侧修改后序列化会重排格式、**注释不保留**——此限制必须在 UI 的 YAML 视图中有文案说明。
- 后端（Rust）零改动；保存契约沿用 `api.saveWorkflow(name, version, yaml)`。
- 每任务：vitest 相关用例绿 + `npm run typecheck` + `npm run build` 通过后按 conventional commits 提交；仓库根执行命令。

---

### Task 1: 可靠 YAML 解析/序列化（`yaml` 包替换脆弱扫描器）

**Files:**
- Modify: `frontend/package.json`（加依赖 `yaml`）
- Create: `frontend/src/api/workflowModel.ts`（模型类型 + 解析/序列化）
- Modify: `frontend/src/api/graph.ts`（`parseWorkflowGraph` 改为基于 yaml 包的薄适配）
- Modify: `frontend/src/api/client.ts`（re-export 调整，如已 re-export parseWorkflowGraph 则保持不变）
- Test: `frontend/src/api/graph.test.ts`（重写扩展）

**Interfaces:**
- Consumes: `WorkflowGraph`（types.ts 既有：`{nodes: {id,agent}[], edges: {from,to,when?}[]}`）
- Produces:

```ts
// workflowModel.ts
export interface RetryModel { max: number; backoff_ms: number }
export interface NodeModel { id: string; agent: string; prompt: string;
  output_schema?: unknown; retry?: RetryModel; timeout_ms?: number }
export interface EdgeModel { from: string; to: string; when?: string }
export interface WorkflowModel { name: string; version: number;
  params: Record<string, string | number | boolean>;
  nodes: NodeModel[]; edges: EdgeModel[] }

/** 严格解析：结构不符返回 { errors }（errors 为中文消息数组，非空即失败）。 */
export function parseWorkflowModel(yaml: string): { model?: WorkflowModel; errors: string[] }
/** 序列化为后端可解析的 YAML（与 WorkflowDef serde 对齐：meta/params/nodes/edges 顶层键）。 */
export function serializeWorkflowYaml(model: WorkflowModel): string
```

- `graph.ts` 的 `parseWorkflowGraph(yaml): WorkflowGraph` 签名不变，实现改为 `parseWorkflowModel` 成功时投影 nodes/edges、失败返回空图（调用方 WorkflowDetail 预览的兜底行为不变）。

- [ ] **Step 1: 安装依赖** — `cd frontend && npm install yaml@^2 --no-audit --no-fund`

- [ ] **Step 2: 写失败测试**（重写 `graph.test.ts`，新增 workflowModel 往返用例）

```ts
// graph.test.ts 保留/新增的关键断言（既有 4 个用例改为对新实现的期望）：
import { parseWorkflowGraph } from './graph';
import { parseWorkflowModel, serializeWorkflowYaml } from './workflowModel';

const VALID = `meta: {name: demo, version: 3}
params: {week: "W38"}
nodes:
  - id: collect
    agent: enterprise
    prompt: "收集 {{ params.week }}"
  - id: analyze
    agent: enterprise
    prompt: "分析 {{ nodes.collect.output }}"
    output_schema: {type: object, required: [ok], properties: {ok: {type: boolean}}}
    retry: {max: 2, backoff_ms: 3000}
    timeout_ms: 600000
edges:
  - {from: collect, to: analyze}
  - {from: analyze, to: report, when: "output.ok == true"}
`;

it('parseWorkflowGraph 解析完整 YAML（含 block 风格与嵌套 output_schema）', () => {
  const g = parseWorkflowGraph(VALID);
  expect(g.nodes.map(n => n.id)).toEqual(['collect', 'analyze']);
  expect(g.edges[1]).toEqual({from: 'analyze', to: 'report', when: 'output.ok == true'});
});

it('parseWorkflowModel 全字段解析 + serialize 往返', () => {
  const { model, errors } = parseWorkflowModel(VALID);
  expect(errors).toEqual([]);
  expect(model!.params).toEqual({week: 'W38'});
  expect(model!.nodes[1].retry).toEqual({max: 2, backoff_ms: 3000});
  expect(model!.nodes[1].timeout_ms).toBe(600000);
  const back = parseWorkflowModel(serializeWorkflowYaml(model!));
  expect(back.errors).toEqual([]);
  expect(back.model).toEqual(model);
});

it('非字典/缺 meta/nodes 非 list/未知顶层键 → errors 非空', () => {
  expect(parseWorkflowModel('- a\n- b').errors.length).toBeGreaterThan(0);
  expect(parseWorkflowModel('foo: bar\n').errors).toContainMatch(/meta|顶层/);
  expect(parseWorkflowModel('meta: {name: x, version: 1}\nnodes: 5\n').errors.length).toBeGreaterThan(0);
});

it('parseWorkflowGraph 对非法 YAML 返回空图（兜底不抛异常）', () => {
  expect(parseWorkflowGraph('::::not yaml')).toEqual({nodes: [], edges: []});
});
```

（`expect(...).toContainMatch` 为 jest-expect 扩展，vitest 没有——用 `errors.some(e => /meta|顶层/.test(e))` 断言代替。）

- [ ] **Step 3: 验证失败** — Run: `cd frontend && npm test -- --run` Expected: FAIL（workflowModel 模块不存在）。

- [ ] **Step 4: 实现** `workflowModel.ts`（YAML.parseDocument；顶层必须为 map；meta.name/version 必填（version 默认 1 可省）；params 缺省 {}；nodes 必须为数组且每项 id/agent/prompt 为字符串（prompt 缺省 ''）；retry/timeout_ms/output_schema 透传不深校验（后端权威）；未知顶层键 → error 提示后端会拒绝。序列化：`{meta: {name, version}, params, nodes, edges}` 以 2 空格缩进 stringify，`lineWidth: 0` 防折叠）；`graph.ts` 按接口说明重写。

- [ ] **Step 5: 验证通过 + 既有回归** — Run: `cd frontend && npm test -- --run && npm run typecheck && npm run build` Expected: 新旧用例全绿（含 runStore/NodeCard/NodeDrawer 既有 23 中未受影响的用例）。

- [ ] **Step 6: Commit** — `git add frontend/ && git commit -m "feat(frontend): yaml 包驱动的可靠工作流解析/序列化（WorkflowModel）"`

---

### Task 2: 前端校验模块 `lib/validate.ts`

**Files:**
- Create: `frontend/src/lib/validate.ts`
- Test: `frontend/src/lib/validate.test.ts`

**Interfaces:**
- Consumes: `WorkflowModel`（Task 1）
- Produces:

```ts
/** 镜像后端校验规则的纯函数；返回中文错误消息数组（空=通过）。
 *  规则：节点 id 非空且唯一；边 from/to 必须引用存在节点；DAG 无环（Kahn）；
 *  when 语法 = ("output."path " == " literal | "output."path " contains " 字符串字面量)（" and " 连接）；
 *  agent 非空；version >= 1；name 非空。 */
export function validateWorkflow(model: WorkflowModel): string[]
```

- [ ] **Step 1: 写失败测试**（六个用例：合法通过/重复 id/悬空边引用/环（a→b→a 与自环）/非法 when（`output.a >= 5`、缺字面量）/空 agent 与空 name）

```ts
import { validateWorkflow } from './validate';
import type { WorkflowModel } from '../api/workflowModel';

const base = (): WorkflowModel => ({ name: 't', version: 1, params: {}, nodes: [
  {id: 'a', agent: 'mock', prompt: 'p'}, {id: 'b', agent: 'mock', prompt: 'p'}],
  edges: [{from: 'a', to: 'b'}] });

it('合法模型通过', () => expect(validateWorkflow(base())).toEqual([]));
it('重复 id / 悬空边 / 自环与环 / 非法 when / 空 agent / 空 name 各报错', () => {
  const dup = base(); dup.nodes[1].id = 'a';
  expect(validateWorkflow(dup).some(m => m.includes('重复'))).toBe(true);
  const dangling = base(); dangling.edges.push({from: 'a', to: 'ghost'});
  expect(validateWorkflow(dangling).some(m => m.includes('ghost'))).toBe(true);
  const cycle = base(); cycle.edges.push({from: 'b', to: 'a'});
  const self = base(); self.edges.push({from: 'a', to: 'a'});
  expect(validateWorkflow(cycle).some(m => m.includes('环'))).toBe(true);
  expect(validateWorkflow(self).some(m => m.includes('环'))).toBe(true);
  const badWhen = base(); badWhen.edges[0].when = 'output.a >= 5';
  expect(validateWorkflow(badWhen).some(m => m.includes('when'))).toBe(true);
  const noAgent = base(); noAgent.nodes[0].agent = '';
  expect(validateWorkflow(noAgent).some(m => m.includes('agent'))).toBe(true);
  const noName = base(); noName.name = '';
  expect(validateWorkflow(noName).some(m => m.includes('name'))).toBe(true);
});
```

- [ ] **Step 2: 验证失败** — Run: `cd frontend && npm test -- --run validate` Expected: FAIL。
- [ ] **Step 3: 实现**（Kahn 同构后端；when 用与 Rust cond.rs 相同语法的微型手写校验器：token 化 ` and `/` == `/` contains `，字面量 = true/false/整数/双引号字符串）。
- [ ] **Step 4: 验证通过** — Run: `cd frontend && npm test -- --run validate` Expected: PASS。
- [ ] **Step 5: Commit** — `git add frontend/src/lib/ && git commit -m "feat(frontend): 工作流前端校验（镜像后端规则：id/引用/环/when 语法）"`

---

### Task 3: 编辑器 store `store/editorStore.ts`

**Files:**
- Create: `frontend/src/store/editorStore.ts`
- Test: `frontend/src/store/editorStore.test.ts`

**Interfaces:**
- Consumes: `WorkflowModel`/`parseWorkflowModel`/`serializeWorkflowYaml`（Task 1）、`NodeStatus`（NodeCard）
- Produces:

```ts
export interface EditorSnapshot { model: WorkflowModel; positions: Record<string, {x: number; y: number}> }

export const useEditorStore: import('zustand').UseBoundStore<EditorState>;
export interface EditorState {
  loaded: boolean;                      // 是否已载入文档（new 或既有）
  model: WorkflowModel | null;
  positions: Record<string, {x: number; y: number}>;
  selected: { type: 'node' | 'edge' | 'settings'; id?: string } | null;
  dirty: boolean;
  past: EditorSnapshot[]; future: EditorSnapshot[];   // 上限各 50
  // 动作（全部走 pushHistory → 变更 → dirty=true）：
  loadYaml(yaml: string): void;         // parseWorkflowModel 失败则 loaded 保持 false 并存 parseErrors
  loadBlank(): void;                    // {name:'my-workflow', version:1, 单节点 step1 agent 'mock'}
  parseErrors: string[];
  addNode(agent: string, pos?: {x: number; y: number}): string;   // 返回新 id（node-1 递增避撞）
  updateNode(id: string, patch: Partial<NodeModel>): void;        // id 变更时同步改 positions 键与 edges 引用
  removeNode(id: string): void;         // 级联删除关联边
  connect(from: string, to: string): void;        // 已存在同向边则忽略；自环允许存入（校验层报环）
  updateEdge(from: string, to: string, patch: Partial<EdgeModel>): void;
  removeEdge(from: string, to: string): void;
  setPositions(next: Record<string, {x: number; y: number}>): void;  // 拖拽结束批量写，不进 history
  setSelection(sel: EditorState['selected']): void;                // 不进 history、不改 dirty
  markSaved(): void;                    // dirty=false
  undo(): void; redo(): void;
  toYaml(): string;                     // model 为空返回 ''
}
```

- [ ] **Step 1: 写失败测试**（≥8 用例：loadYaml 解析成功/失败路径；addNode 自增 id 与默认内容 `{id, agent, prompt: ''}`；updateNode 改 id 时 edges/positions 同步重构；removeNode 级联删边；connect 去重；undo/redo 覆盖 add→undo→redo 的模型与 positions；setPositions 不产生历史；toYaml 与 loadYaml 往返相等）

```ts
// 关键用例骨架（vitest，直接 set/get 操作 store；每用例先 loadBlank()）：
it('改节点 id 同步重构边与位置', () => {
  const s = useEditorStore.getState();
  s.loadBlank();
  const b = s.addNode('mock');
  s.connect('step1', b);
  s.updateNode('step1', {id: 'collect'});
  const m = useEditorStore.getState().model!;
  expect(m.nodes.some(n => n.id === 'collect')).toBe(true);
  expect(m.edges).toEqual([{from: 'collect', to: b, ...({} as object)}].map(e => ({from: e.from, to: e.to})));
  expect(useEditorStore.getState().positions['collect']).toBeDefined();
  expect(useEditorStore.getState().positions['step1']).toBeUndefined();
});
it('undo/redo：add→undo 复原→redo 恢复', () => {
  useEditorStore.getState().loadBlank();
  useEditorStore.getState().addNode('mock');
  useEditorStore.getState().undo();
  expect(useEditorStore.getState().model!.nodes.length).toBe(1);
  useEditorStore.getState().redo();
  expect(useEditorStore.getState().model!.nodes.length).toBe(2);
});
it('toYaml → loadYaml 往返', () => {
  useEditorStore.getState().loadBlank();
  const n = useEditorStore.getState().addNode('mock');
  useEditorStore.getState().updateNode(n, {prompt: 'p2', retry: {max: 1, backoff_ms: 500}});
  const yaml = useEditorStore.getState().toYaml();
  useEditorStore.getState().loadYaml(yaml);
  expect(useEditorStore.getState().model!.nodes.find(x => x.id === n)?.retry).toEqual({max: 1, backoff_ms: 500});
});
```

- [ ] **Step 2: 验证失败** — Run: `cd frontend && npm test -- --run editorStore` Expected: FAIL。
- [ ] **Step 3: 实现**（zustand create；`pushHistory` 私有辅助：`{model: clone(model), positions: {...positions}}` 深拷贝入 past、清 future、截断至 50；`loadYaml` 成功时重置 past/future/dirty）。
- [ ] **Step 4: 验证通过** — Run: `cd frontend && npm test -- --run editorStore` Expected: PASS。
- [ ] **Step 5: Commit** — `git add frontend/src/store/ && git commit -m "feat(frontend): 画布编辑器文档模型 store（快照式撤销重做/级联编辑/YAML 往返）"`

---

### Task 4: 可编辑画布 `components/EditableCanvas.tsx` + 节点面板

**Files:**
- Create: `frontend/src/components/EditableCanvas.tsx`
- Create: `frontend/src/components/Palette.tsx`
- Modify: `frontend/src/styles.css`（追加 `.fs-editwrap/.fs-palette/.fs-palette__item/.fs-canvas--edit` 等样式，全部用既有变量）
- Test: `frontend/src/components/EditableCanvas.test.tsx`

**Interfaces:**
- Consumes: `useEditorStore`（Task 3）、`nodeTypes`、`layoutGraph`（既有 lib）、`api.listAgents`——若 client.ts 无此方法则本任务补 `listAgents(): {key: string; name: string}[]`（GET /api/agents 已存在，返回 `[{key,name,permission_default,healthy}]`）
- Produces:

```tsx
export default function EditableCanvas(): JSX.Element
// <div className="fs-editwrap"> <Palette /> <div className="fs-canvas fs-canvas--edit"> <ReactFlow .../> </div> </div>
// ReactFlow 关键配置：
//   nodes = editorStore.model.nodes.map(n => ({ id, type: 'agent', position: positions[id] ?? 布局结果,
//            data: { id, agent, status: 'pending' } }))  // 复用 NodeCard，未保存修改用 data.status 不变
//   edges = model.edges.map(e => ({ id: `${e.from}->${e.to}`, source: e.from, target: e.to,
//            type: 'smoothstep', label: e.when, className: e.when ? 'fs-edge--cond' : undefined }))
//   onConnect={(c) => c.source && c.target && connect(c.source, c.target)}
//   onNodesDelete / onEdgesDelete → removeNode / removeEdge
//   onNodeDragStop={(e, node) => setPositions({...positions, [node.id]: node.position})}
//   onNodeClick={(e, node) => setSelection({type: 'node', id: node.id})}
//   onEdgeClick={(e, edge) => setSelection({type: 'edge', id: edge.id})}
//   onPaneClick={() => setSelection(null)}    // 空白处点击 → settings 态由父层处理
//   nodesDraggable nodesConnectable elementsSelectable deleteKeyCode={['Backspace','Delete']}
// Palette：useQuery(['agents'], api.listAgents)；每项 draggable + 双触发：
//   HTML5 dragStart(dataTransfer 'application/flowscope-agent', key) → 画布 onDrop(screenToFlowPosition(event) → addNode(key, pos))
//   「添加」按钮（data-testid={`palette-add-${key}`}）→ addNode(key, 画布中心)   // e2e 与键盘可达路径
```

- [ ] **Step 1: 写失败组件测试**（jsdom 下无真实 RF 渲染细节，测交互接线：render `<EditableCanvas />` 包 `ReactFlowProvider`，store 预置两节点一边；断言：点 palette-add-mock 按钮后 store 节点数 +1 且选中该节点；点节点卡片（data-testid）后 selected 为该 node；断言 edges 的 label 取自 when）

```tsx
it('palette 添加按钮向 store 增加节点并选中', () => {
  useEditorStore.getState().loadBlank();
  render(<ReactFlowProvider><EditableCanvas /></ReactFlowProvider>);
  act(() => { useEditorStore.getState().setSelection(null); });
  fireEvent.click(screen.getByTestId('palette-add-mock'));
  const s = useEditorStore.getState();
  expect(s.model!.nodes.length).toBe(2);
  expect(s.selected?.type).toBe('node');
});
```

- [ ] **Step 2: 验证失败** — Run: `cd frontend && npm test -- --run EditableCanvas` Expected: FAIL。
- [ ] **Step 3: 实现**（如上接口块；`screenToFlowPosition` 为 RF12 API；Palette 空态显示「未注册 agent，请编辑 agents.toml」；css：palette 为画布左上浮层 168px 宽卡片列，item 可拖、hover 高亮，含小圆点 agent 图标字符 `◆`）。
- [ ] **Step 4: 验证通过** — Run: `cd frontend && npm test -- --run && npm run typecheck` Expected: PASS。
- [ ] **Step 5: Commit** — `git add frontend/src/ && git commit -m "feat(frontend): 可编辑 DAG 画布与节点面板（拖入/连边/删除/选中/位置持久）"`

---

### Task 5: 属性面板 `components/PropertyPanel.tsx`（三态表单）

**Files:**
- Create: `frontend/src/components/PropertyPanel.tsx`
- Modify: `frontend/src/styles.css`（表单样式：`.fs-form-row/.fs-form-label/.fs-form-input` 等）
- Test: `frontend/src/components/PropertyPanel.test.tsx`

**Interfaces:**
- Consumes: `useEditorStore`、`api.listAgents`、`validateWorkflow`（Task 2，仅用于 id 即时冲突提示）
- Produces:

```tsx
export default function PropertyPanel({ problems }: { problems: string[] }): JSX.Element
// 三态（由 store.selected 驱动）：
// ① node 态：id(文本,失焦提交 updateNode)/agent(下拉,agents)/prompt(textarea rows=6)/
//    retry.max+retry.backoff_ms(数字,空=删除字段)/timeout_ms(数字)/output_schema(textarea JSON,
//    失焦 JSON.parse 校验失败红框不提交)/删除节点按钮(fs-btn--danger)
// ② edge 态：显示 from → to；when 条件编辑器 = 结构化三件套：
//    字段路径 input(占位 output.ok) + 操作符 select(==/contains) + 值 input(占位 true 或 "文本")
//    + 「高级：直接编辑表达式」折叠 raw textarea；两者双向同步（结构化优先，raw 变更解析成功则回填三件套）
//    + 删除连线按钮；when 清空 = 无条件边
// ③ settings 态（含 selected=null）：name/version(数字)/params 键值编辑器
//    （行 = key input + 值 input + 删除；「添加参数」按钮；值按 YAML 标量解析：true/1/文本）
// 底部公共区：problems 列表（fs-error-text 每行一条，空则显示「✓ 校验通过」）
```

- [ ] **Step 1: 写失败组件测试**（≥4 用例：node 态改 prompt 写回 store 且 dirty；output_schema 非法 JSON 不提交并显示错误；edge 态结构化三件套拼出 `output.ok == true` 写回 when、raw 输入非法时不动 store；settings 态 params 增删行写回）

```tsx
it('edge 条件三件套生成 when 表达式', () => {
  useEditorStore.getState().loadBlank();
  const b = useEditorStore.getState().addNode('mock');
  useEditorStore.getState().connect('step1', b);
  useEditorStore.getState().setSelection({type: 'edge', id: `step1->${b}`});
  render(<PropertyPanel problems={[]} />);
  fireEvent.change(screen.getByLabelText('字段路径'), {target: {value: 'output.ok'}});
  fireEvent.change(screen.getByLabelText('值'), {target: {value: 'true'}});
  const m = useEditorStore.getState().model!;
  expect(m.edges[0].when).toBe('output.ok == true');
});
```

- [ ] **Step 2: 验证失败** — Run: `cd frontend && npm test -- --run PropertyPanel` Expected: FAIL。
- [ ] **Step 3: 实现**（受控读 store、失焦/onChange 防抖写 store；id 输入即时用 validateWorkflow 检测「重复 id」就地红提示但仍允许提交——保存门统一拦）。
- [ ] **Step 4: 验证通过** — Run: `cd frontend && npm test -- --run PropertyPanel` Expected: PASS。
- [ ] **Step 5: Commit** — `git add frontend/src/ && git commit -m "feat(frontend): 属性面板三态表单（节点属性/条件边结构化编辑/工作流设置）"`

---

### Task 6: WorkflowDetail 重写（画布为主交互）

**Files:**
- Modify: `frontend/src/views/WorkflowDetail.tsx`（整体重写）
- Modify: `frontend/src/styles.css`（`.fs-editor-layout/.fs-edit-toolbar/.fs-yamlview` 等）
- Test: 既有组件测试回归 + `frontend/src/views/WorkflowDetail.test.tsx`（新增轻量：工具栏按钮渲染与禁用态）

**Interfaces:**
- Consumes: Task 3/4/5 全部；既有 `api.getWorkflow/saveWorkflow/startRun`、`validateWorkflow`
- Produces: `/workflows/:id` 新交互形态（对外契约：按钮文本「启动运行」「保存」保留；路由与保存跳转行为不变）

```tsx
// 结构：
// <div className="fs-page fs-page--editor">
//   <header className="fs-page__head"> 标题 + dirty 圆点 | 工具栏：
//     [撤销][重做] | [YAML 源码] | 校验状态徽章(✓/⚠N) | [保存] [启动运行(仅已保存)] </header>
//   <div className="fs-editor-layout">   // flex：左画布 flex-1，右 PropertyPanel 384px
//     <EditableCanvas /> <PropertyPanel problems={problems} /> </div>
// </div>
// 行为：
//   载入：isNew → editorStore.loadBlank()；否则 wfQuery.data.yaml → loadYaml
//   problems = useMemo(() => model ? validateWorkflow(model) : ['未加载'], [model])
//   保存：problems 非空 → 禁用按钮 + title 列出首条；点击 → saveWorkflow(name, version, toYaml())
//        → onSuccess markSaved() + invalidateQueries(['workflows'],['workflow']) + isNew 跳转
//   YAML 源码：切换浮层（fixed 右侧滑入 520px）textarea 显示 toYaml()；
//     头部说明「图形编辑后导出会重排格式、注释不保留」；[应用] → loadYaml(文本)（失败显示 parseErrors 不覆盖画布）
//   启动：沿用 M1 params 自由 JSON 文本域（放 YAML 浮层同款滑层或 settings 态面板底部——落定：settings 态底部「启动参数」区 + 工具栏「启动运行」读取之）
//   撤销/重做按钮 disabled 随 past/future 空置；快捷键 Ctrl+Z / Ctrl+Shift+Z（onKeyDown 挂 page 容器）
```

- [ ] **Step 1: 写失败测试**（渲染 `/workflows/new` 形态：loadBlank 后断言工具栏含「保存」「启动运行」「撤销」「重做」「YAML 源码」；撤销在空历史时 disabled；制造校验错误（清空 name）后保存禁用）

```tsx
it('校验错误时保存禁用，修复后恢复', () => {
  useEditorStore.getState().loadBlank();
  render(<WorkflowDetail />);   // MemoryRouter 路由参数 id='new'
  const save = screen.getByRole('button', {name: '保存'});
  expect(save).not.toBeDisabled();
  act(() => useEditorStore.getState().updateNode('step1', {id: ''}));
  expect(screen.getByRole('button', {name: '保存'})).toBeDisabled();
});
```

- [ ] **Step 2: 验证失败** — Run: `cd frontend && npm test -- --run WorkflowDetail` Expected: FAIL。
- [ ] **Step 3: 实现**（如上结构；旧 `GraphPreview`/yamlText 主编辑区删除；DEFAULT_YAML 模板由 loadBlank 取代）。
- [ ] **Step 4: 验证通过 + 全量回归** — Run: `cd frontend && npm test -- --run && npm run typecheck && npm run build` Expected: 全绿。
- [ ] **Step 5: Commit** — `git add frontend/src/ && git commit -m "feat(frontend): 工作流详情重写——画布为主交互（工具栏/校验门/YAML 源码层/撤销重做）"`

---

### Task 7: E2E——画布搭建工作流全链路

**Files:**
- Create: `frontend/e2e/build-via-canvas.spec.ts`
- Constraint: 不得改 `run.spec.ts`

**Interfaces:**
- Consumes: Task 4/5/6 的 testid（`palette-add-mock`、按钮「保存」「启动运行」「YAML 源码」、PropertyPanel 表单 label「字段路径/值」）+ 既有 `.fs-node--succeeded` 终态断言

- [ ] **Step 1: 写用例**

```ts
import { test, expect } from '@playwright/test';

test('从零画布搭一条 2 节点工作流并跑通', async ({ page }) => {
  await page.goto('/workflows/new');
  await expect(page.getByTestId('palette-add-mock')).toBeVisible();
  // loadBlank 自带 step1；再添加一个节点
  await page.getByTestId('palette-add-mock').click();
  // 连线：拖 source handle → target handle（RF handle 定位器）
  const src = page.locator('.react-flow__node[data-id="step1"] .react-flow__handle.source');
  const dst = page.locator('.react-flow__node[data-id="node-1"] .react-flow__handle.target');
  await page.mouse.move(...(await src.boundingBox()).centerXY);
  // centerXY 不存在——用 box 计算：const b = await src.boundingBox(); await page.mouse.move(b.x+b.width/2, b.y+b.height/2);
  await page.mouse.down();
  const d = await dst.boundingBox(); await page.mouse.move(d.x+d.width/2, d.y+d.height/2, {steps: 6});
  await page.mouse.up();
  // 选中 node-1 填 prompt（点击节点卡片 → PropertyPanel）
  await page.locator('.react-flow__node[data-id="node-1"]').click();
  await page.getByLabelText('Prompt').fill('输出 {"ok": true}');
  // settings 态改名
  await page.locator('.react-flow__pane').click({position: {x: 40, y: 40}});
  await page.getByLabelText('名称').fill('canvas-e2e');
  // 保存 → 启动 → 监控页 2 节点全绿
  await page.getByRole('button', {name: '保存'}).click();
  await expect(page.getByRole('button', {name: '启动运行'})).toBeEnabled();
  await page.getByRole('button', {name: '启动运行'}).click();
  await expect(page.locator('.fs-node--succeeded')).toHaveCount(2, {timeout: 15_000});
  await expect(page.getByTestId('run-status, .fs-topbar .fs-badge').first()).toHaveText(/finished/);
});
```

（注释里的 centerXY 修正已给出；`run-status` testid 若不存在则用 `.fs-topbar .fs-badge`——以 Task 6 实现时真实 DOM 为准，允许实现侧补一个 `data-testid="run-status"` 到 RunMonitor 顶栏徽章——这是本计划对 RunMonitor 的唯一授权改动。）

- [ ] **Step 2: 运行调通** — Run: `cd frontend && npx playwright test e2e/build-via-canvas.spec.ts` Expected: PASS；再 `npm run e2e` 全量（3 用例）Expected: 3/3。
- [ ] **Step 3: Commit** — `git add frontend/e2e/ frontend/src/views/RunMonitor.tsx && git commit -m "test(e2e): 画布搭建工作流全链路（palette/连线/属性面板/保存/启动/点亮）"`

---

### Task 8: README 用户指南更新 + 截图

**Files:**
- Modify: `README.md`（§1.1 第 3 步改写为画布编辑主线：添加节点→连线→属性面板→保存；YAML 降级为「源码视图/导入导出」小节；已知限制删除「YAML 图解析器脆弱」条目——Task 1 已消除；M2a 交付写进版本边界）
- Create: `docs/assets/workflow-editor.png`（浏览器截图：带 2+ 节点与属性面板的编辑页）

**Interfaces:**
- Consumes: Task 6 的页面（运行中的 dev 服务器 + 浏览器截图由执行者用 Playwright `page.screenshot` 落盘——e2e 环境已有，可写一次性脚本或直接手动 `npx playwright screenshot` 命令：`npx playwright screenshot --viewport-size=1440,900 "http://127.0.0.1:39271/workflows/new" docs/assets/workflow-editor.png`（需先登录态无——本地无鉴权，直接可用；palette 需 agents 存在——dev 服务器已种子））

- [ ] **Step 1: 截图**（启动 dev 服务器后台 → playwright screenshot 命令落盘 → 校验文件 >30KB）
- [ ] **Step 2: 改写 README §1.1 第 3 步与相关小节**（操作路径与 Task 6 实际 UI 一致；预览表加编辑器截图列或行）
- [ ] **Step 3: 全量回归** — `cd frontend && npm test -- --run && npm run e2e` + `cargo test -p flowscope-core`（后端零改动应 45 绿）
- [ ] **Step 4: Commit** — `git add README.md docs/assets/ && git commit -m "docs: 用户指南改写为画布编辑主线 + 编辑器截图"`

---

## Self-Review 记录

- **Spec 覆盖**（spec §7.1 M2 编辑器条目）：拖入新增（Task 4 palette + HTML5 drop）✓、连线把手拖拽建边/删边（Task 4 onConnect + deleteKeyCode）✓、内联属性面板（Task 5 node 态：prompt/retry/timeout/output_schema）✓、条件边表单化（Task 5 edge 态三件套+raw）✓、撤销重做（Task 3 快照 + Task 6 按钮/快捷键）✓、YAML 双向与注释不保留文案（Task 1 序列化 + Task 6 源码层说明）✓。settings 表单（name/version/params）超出 spec 最小面但属"表单式节点属性编辑"M1 缺口追偿（backlog #14），并入 Task 5。
- **占位符扫描**：Task 7 Step 1 内嵌的 centerXY 错误已在注释中即时修正为 box 计算写法——保留原样是刻意的（执行者需按注释修正，防盲抄）；无 TBD/TODO。
- **类型一致性**：`WorkflowModel/NodeModel/EdgeModel`（Task 1 定义，Task 2/3/5 消费同名字段）；`addNode(agent, pos?) -> string`；`updateNode(id, patch)` 改 id 的级联语义在 Task 3 测试与 Task 5 实现间一致（失焦提交）；`palette-add-${key}` testid 在 Task 4 定义、Task 7 消费；PropertyPanel 的 label「字段路径/值/Prompt/名称」在 Task 5 定义（getByLabelText 要求 label htmlFor 关联——Task 5 实现须用 `<label htmlFor>` 或 aria-label，写入实现要求）、Task 7 消费同名。
