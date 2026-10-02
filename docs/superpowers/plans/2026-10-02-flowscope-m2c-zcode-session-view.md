# FlowScope M2c（ZCode ACP 接入 + 节点会话视图）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** FlowScope 采用 workflow-demo.html 的交互形式：单击节点进入全页「节点会话」视图（气泡对话/思考折叠块/工具卡/协议事件抽屉，回放与实时统一）；后端支持把 ZCode（经 zcode-acp-server 桥）注册为 ACP agent 供本地实测；画布节点带流式消息预览行。

**Architecture:** 后端两处小改——① bootstrap 默认 agents.toml 注册 `zcode` agent（spawn 本机 zcode-acp-server 桥，env 注入 ZCODE_NODE/ZCODE_ACP_RUNTIME）；② acp 层支持 model 配置（session/new 后发 `session/set_config_option`，未配置时从 configOptions 选第一个非 start-plan 项）+ node.started payload 带渲染后 prompt（补 M1 可观测缺口，会话视图的用户气泡需要它）。前端——新路由 `/runs/:runId/sess/:nodeId` 会话视图（数据源=既有 SSE after=0 回放+实时，天然统一）+ NodeCard 消息预览行 + 抽屉/双击入口。

**Tech Stack:** 既有栈，零新增依赖。

**Spec:** 参考 D:\zcode_processing\zcode-acp-demo\workflow-demo.html（交互形式）与 D:\zcode_processing\zcode-acp-demo\README.md（ZCode ACP 桥事实）。

## Global Constraints

- 零新增 npm 依赖、零新增 crate 依赖。
- 既有测试全绿：cargo 45、vitest 90、e2e 4；`run.spec.ts`/`build-via-canvas.spec.ts` 不得修改。
- ZCode 桥事实（本机已验证）：桥入口 `D:\zcode_processing\zcode-acp-demo\node_modules\zcode-acp-server\dist\cli.js`（启动参数 `server`）；`ZCODE_NODE=D:\zcode_processing\tools\node-v22.20.0-win-x64\node.exe`；`ZCODE_ACP_RUNTIME=node`；模型必须避开 start-plan（无头必败），默认 `builtin:bigmodel-coding-plan\GLM-5.3-Flash`；设置方式 `session/set_config_option {configId:"model", value}`。
- UI 中文；沿用深色主题变量；会话视图视觉参照 workflow-demo.html（气泡 12px 圆角/思考 details 折叠/工具卡/stop chip/底部协议抽屉）。
- 每 Task 结束 `cargo fmt`（后端）与全量门禁通过后提交；仓库根执行命令。

---

### Task 1: 后端——ZCode agent 注册 + model 配置 + prompt 进事件

**Files:**
- Modify: `crates/flowscope-core/src/api.rs`（bootstrap 默认 agents.toml 增 zcode 条目）
- Modify: `crates/flowscope-core/src/acp/registry.rs`（AgentConfig 增 `model: Option<String>` + toml 字段）
- Modify: `crates/flowscope-core/src/acp/session.rs`（session/new 后 model 逻辑；NodeRequest/事件透传 prompt）
- Modify: `crates/flowscope-core/src/engine.rs`（node.started payload 增 `prompt` 字段=渲染后 prompt）
- Test: 上述文件的既有测试模块扩展

**Interfaces:**
- Consumes: 既有 run_agent_node/engine 流水线；`ActiveSession::config_options()`（读）；`session/set_config_option`（发送 API 在 crate 内探：docs.rs agent_client_protocol 2.2 或本地 `cargo doc`/源码 grep set_config_option——找到类型化方法或经 ConnectionTo 的通用 call；实在无 API 则该逻辑降级为「仅记录 configOptions 选择」并报 BLOCKED）
- Produces:
  - agents.toml zcode 条目（bootstrap 生成，桥文件存在时才写入）：
    ```toml
    [agents.zcode]
    name = "ZCode (ACP 桥)"
    command = ["<ZCODE_NODE>", "<ZCODE_ACP_BRIDGE>", "server"]
    env = { ZCODE_NODE = "<ZCODE_NODE>", ZCODE_ACP_RUNTIME = "node" }
    model = "builtin:bigmodel-coding-plan\\GLM-5.3-Flash"
    ```
    路径解析优先级：env `ZCODE_NODE`/`ZCODE_ACP_BRIDGE` → 本机默认（`D:\zcode_processing\tools\node-v22.20.0-win-x64\node.exe`、`D:\zcode_processing\zcode-acp-demo\node_modules\zcode-acp-server\dist\cli.js`）→ 文件不存在则不注册该条目。`ZCODE_ACP_CWD`（默认用户主目录）作为 cwd。
  - AgentConfig.model: Option<String>（toml `model`，serde default None）
  - session/new 后的 model 逻辑：`if let Some(m)=&cfg.model { 发送 set_config_option(model=m) } else { 从 config_options() 取 id=="model" 的 options 中第一个 value 不含 "start-plan" 的发送 }`；发送失败仅 tracing::warn 不阻断。
  - node.started payload: 在既有字段基础上增 `"prompt": <渲染后 prompt 字符串>`（engine 在 render_prompt 成功后 emit；渲染失败路径无 prompt 字段）。

- [ ] Step 1: 失败测试——registry 解析 model 字段 + 默认 toml 含 zcode（条件：桥文件存在，测试用 env 指向临时假文件验证条目生成与 command 展开）；session model 逻辑对 mock（model=None 且 mock 的 configOptions 为空→不发、不炸）不回归。engine 测试：node.started payload 含 prompt。
- [ ] Step 2: 实现（顺序：registry→session→engine→bootstrap）。
- [ ] Step 3: `cargo test -p flowscope-core` 45+ 全绿；`cargo fmt`。
- [ ] Step 4: Commit `feat(core): ZCode ACP 桥 agent 注册、model 配置与会话 prompt 事件化`

### Task 2: 前端——节点会话视图（demo 形式）

**Files:**
- Create: `frontend/src/views/NodeSession.tsx`（全页会话视图）
- Create: `frontend/src/components/ProtocolDrawer.tsx`（协议事件抽屉，复用样式）
- Modify: `frontend/src/App.tsx`（路由 `/runs/:runId/sess/:nodeId`）
- Modify: `frontend/src/components/NodeDrawer.tsx`（头部加「会话视图」按钮）
- Modify: `frontend/src/views/RunMonitor.tsx`（节点卡片双击 → 会话视图）
- Modify: `frontend/src/styles.css`（追加会话视图样式，参照 workflow-demo.html 的 .msg-user/.think/.tool/.stop-chip/.evt，用既有变量）
- Test: `frontend/src/views/NodeSession.test.tsx`

**Interfaces:**
- Consumes: `useRunEvents(runId)`（SSE after=0 自动回放+实时）、`runStore`（NodeView：promptFromEvent、message、reasoning[]、tools[]、status）、`api.getWorkflow`（节点标题/icon 用 id+agent 即可）
- Produces:
  - 视图结构（对照 demo）：顶栏（← 返回监控 + 节点 id/agent + 状态徽标 + SSE 连接指示）；nodeBanner（session/prompt: 渲染后 prompt——来自 node.started 事件的 payload.prompt，Task 1）；对话流（用户气泡=prompt；agent turn=思考 details 折叠块(reasoning join)+正文(message，mdLite 已有？无——纯文本 pre-wrap 即可)+工具卡列表(状态徽标)+stopReason chip(node.finished/failed/cancelled)；协议抽屉（底部，默认折叠）：该节点事件按 seq 列表，行=kind+payload 摘要，单击展开完整 JSON。
  - 渲染规则：status==='running' 时 message 尾部随 SSE 实时追加（自然流式）；finished 历史一次性整段渲染（不做假打字机）。
  - 入口：抽屉头部「会话视图」按钮 + RunMonitor 节点卡片 onNodeDoubleClick → navigate(`/runs/${runId}/sess/${nodeId}`)。
- [ ] Step 1: 失败测试——(a) 用预置 store（applyEvent 序列：node.started{prompt}→msg.delta×2→tool.update→node.finished）渲染 NodeSession，断言：用户气泡文本=prompt、思考块存在、正文含 delta 拼接、工具卡渲染、stop chip=end_turn... 实际 stopReason 在 payload.reason；chip 文本=node.finished；(b) 抽屉行点击展开完整 JSON；(c) 路由可达（MemoryRouter+createMemoryRouter 均可）。
- [ ] Step 2: 实现。
- [ ] Step 3: `npm test -- --run && npm run typecheck && npm run build && npm run e2e` 全绿（90+ 新）。
- [ ] Step 4: Commit `feat(frontend): 节点会话视图——对话流回放/实时与协议事件抽屉`

### Task 3: 前端——画布节点消息预览行

**Files:**
- Modify: `frontend/src/store/runStore.ts`（NodeView 无需改，message 已有）
- Modify: `frontend/src/views/RunMonitor.tsx`（node data 增 `preview` 字段=running 时 message 尾部 48 字符 / succeeded 时尾部 48 字符）
- Modify: `frontend/src/components/NodeCard.tsx`（新增 `.fs-node__preview` 行：preview 存在时显示，省略号）
- Modify: `frontend/src/styles.css`（预览行样式）
- Test: `frontend/src/components/NodeCard.test.tsx` 扩展

**Interfaces:**
- Produces: NodeCardData 增 `preview?: string`；preview 行在 body 内（不在 handle 侧，几何稳定）。
- [ ] Step 1: 失败测试（preview 渲染与省略）。
- [ ] Step 2: 实现。
- [ ] Step 3: 门禁全绿。
- [ ] Step 4: Commit `feat(frontend): 画布节点消息预览行`

### 验收（控制台本地实测，非子代理）

1. `cargo run --bin dev`（注册 zcode agent 需桥文件存在→默认 toml 含 zcode）
2. 画布建单节点工作流 agent=zcode，prompt=「在当前目录创建 hello_flowscope.txt 写入 ok」→ 启动
3. 节点会话视图：真实 ZCode 流式对话 + 协议抽屉 + 工具卡；产物文件落盘
4. README 快速开始补「接入 ZCode 本地实测」小节

## Self-Review 记录

- 注意1（ZCode ACP 底层）→ Task 1；注意2（增删改查+prompt 配置）→ M2a 已交付（画布 CRUD + PropertyPanel prompt 编辑），无需改动，验收时确认；注意3（节点=session、点击回放/实时日志）→ Task 2。
- 渲染后 prompt 进 node.started 同时清偿 M2b 待办 #16（T11-M1 缺口）。
- 会话视图不含续问输入框（引擎单 turn 语义，session/load 为 M2 后续）——demo 的 composer 不搬。
- 风险：crate 的 set_config_option 发送 API 可能不存在 → Task 1 内探明，无 API 则 BLOCKED 上报（不得静默降级为不切模型——start-plan 无头必败会导致用户实测全红）。
