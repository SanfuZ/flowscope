# FlowScope 设计文档

- 日期：2026-09-22
- 状态：已交付（历史设计记录——M1 设计 + M2a 编辑器修订；**系统现状以此为准：specs/2026-10-02-flowscope-current-state.md**）
- 工作名：FlowScope（目录 `agent-flow-scope`，可随时改名）

## 1. 概述

FlowScope 是一个面向企业级 coding agent 的**工作流可视化监控工具**：把由多个 ACP（Agent Client Protocol）session 组成的静态工作流渲染为 DAG 画布，每个节点的执行状态、agent 消息流、工具调用、plan 子任务与原始日志实时呈现，支持历史回放。

目标用户场景：

1. **演示**：向利益相关方直观展示"agent 在工作流的哪一步、正在做什么、做到什么程度"。
2. **观察与调试**：单人深度观察企业 agent 在各阶段的行为（工具调用序列、plan 演化、失败现场）。

### 核心约束（已确认的决策）

| 决策点 | 结论 |
|---|---|
| 企业 agent 接入方式 | 由使用方包装为 **ACP agent**（JSON-RPC over stdio 子进程），FlowScope 只做 ACP **客户端** |
| 工作流形态 | **混合**：静态 DAG 骨架（节点预定义）+ 节点内动态（ACP update 实时渲染） |
| 部署拓扑 | **双模式**：Tauri 桌面单机（进程内嵌引擎）+ 独立服务器（远程承载引擎） |
| 用户规模 | **纯单人**：无用户体系；服务器模式仅一个随机 bearer token |
| 多端范围 | **桌面三平台（Win/macOS/Linux）+ Web 浏览器**；不做移动端 |
| 架构方案 | **统一 HTTP**：桌面版进程内嵌 axum 服务器（127.0.0.1），前端任何形态都走 HTTP/SSE |

### 非目标（明确不做）

- 多用户、RBAC、审计（纯单人）
- 移动端（iOS/Android）
- 完整表达式引擎 / 通用工作流平台（不是 n8n/Airflow 替代品）
- ACP v2 草案特性的完整实现（仅留 feature flag 跟进位）
- agent 的编辑/干预执行路径（HITL 审批 UI 为二期候选，MVP 仅自动策略 + 事件记录）

## 2. 总体架构

### 2.1 代码组织（Cargo workspace + 前端）

```
agent-flow-scope/
├─ Cargo.toml                 # workspace 根
├─ crates/
│  ├─ flowscope-core/         # 引擎（纯库 crate）
│  │  └─ src/
│  │     ├─ acp/              # ACP 客户端：agent 注册表、子进程管理、update→事件转换、回调应答策略
│  │     ├─ engine/           # DAG 编排执行器（tokio 任务图、重试、超时、取消）
│  │     ├─ events/           # 统一事件模型（kind 枚举、payload schema）
│  │     ├─ store/            # SQLite 存储（workflows/runs/events/sessions/artifacts）
│  │     └─ api/              # axum Router 构建（REST + SSE），桌面/服务器共用
│  ├─ flowscope-server/       # 独立服务器二进制：调用 core 的 Router，绑 0.0.0.0:<port>，托管 frontend/dist，校验 bearer token
│  └─ flowscope-mock-agent/   # 可编程模拟 ACP agent（测试资产 + ACP 兼容性首个验证对象）
├─ apps/
│  └─ desktop/                # Tauri 2 应用：进程内启动 core Router（127.0.0.1 随机端口，免鉴权），WebView 加载前端
├─ frontend/                  # React + Vite + TS：React Flow / Zustand / TanStack Query / react-window
│                             # 同一份构建产物：Tauri 加载 & server 静态托管（Web 版）
└─ docs/superpowers/          # spec 与实施计划
```

### 2.2 运行形态

| 形态 | 进程 | 引擎位置 | 鉴权 | agent 子进程 |
|---|---|---|---|---|
| 桌面单机 | Tauri 应用（含 WebView + 内嵌 axum） | Tauri 进程内，绑 127.0.0.1 随机端口 | 无 | 本机 spawn |
| 服务器 | `flowscope-server` 单二进制 | 独立进程，绑 0.0.0.0:port | 随机 bearer token（首启生成写入配置） | 服务器上 spawn |
| Web 团队围观 | 浏览器 | 连接服务器 | 同上 token | — |

前端唯一的环境差异是 base URL 与 token；无 IPC、无传输抽象层。

### 2.3 关键依赖

- Rust：`agent-client-protocol`（v2.2.0，Apache-2.0，Client 角色）、`axum`、`tokio`、`rusqlite`（bundled SQLite）、`serde`/`serde_yaml`、`minijinja`、`tracing`
- 前端：React 18、Vite、TypeScript、`@xyflow/react`（React Flow 12）、`zustand`、`@tanstack/react-query`、`react-window`
- 桌面：Tauri 2

## 3. ACP 接入层

### 3.1 Agent 注册表

`~/.flowscope/agents.toml`（或 `FLOWSCOPE_HOME` 指定目录），每个条目：

```toml
[agents.enterprise]
command = ["node", "enterprise-agent.js", "--acp"]   # spawn 命令
cwd = "D:/agents/enterprise"
env = { API_KEY_FILE = "secrets/api.key" }            # 值仅支持文件引用/明文，永不入库
default_mode = "plan"                                  # 可选：session 默认 mode
name = "企业 Agent"
```

初始化握手（`initialize`）后读取 agent 声明的 `protocolVersion`、`authMethods`、`modes`、`client_capabilities`（fs/terminal），持久化为 agent 元数据。

### 3.2 节点 ↔ session 映射

工作流中每个 `agent` 节点执行期恰好对应一条 ACP session：

1. `session/new`（cwd、mcpServers 留空、mode 取节点配置或 agent 默认）
2. `session/prompt`（渲染后的 prompt）
3. 持续消费 `session/update` 通知流，逐条转换为统一事件（见 3.4）
4. 收到带 `stopReason` 的 `session/prompt` 响应后节点收尾；`end_turn` → 成功，`cancelled` → 取消，`refusal`/`max_tokens` → 失败
5. session 用后关闭（`session/load` 复用既有会话为二期候选，MVP 不做）

### 3.3 客户端回调应答策略（MVP）

agent 反向调用 FlowScope 时按策略自动应答，**每次应答生成一条事件**（策略决策全程可见）：

| agent→client 调用 | MVP 策略 | 事件 |
|---|---|---|
| `fs/read_text_file` | 放行（仅限 agent 注册表 cwd 白名单内） | `callback.allowed / callback.denied` |
| `fs/write_text_file` | 拒绝 | 同上 |
| `terminal/start` / `terminal/wait` | 拒绝 | 同上 |
| `session/request_permission` | 按 agent 配置 `permission_default = "allow_once" \| "deny"` 应答 | `permission.auto` |

### 3.4 ACP update → 统一事件映射

| ACP | FlowScope 事件 kind | 说明 |
|---|---|---|
| `session/update → agent_message_chunk`（content_type: text / reasoning） | `msg.delta` | 节点消息流增量；reasoning 单独标记 |
| `session/update → tool_call`（status: pending / in_progress / completed / error；content blocks：text、diff，_locations） | `tool.update` | 工具标题/类型/状态/内容块全量入 payload |
| `session/update → tool_call_update` | `tool.update` | 状态迁移 |
| `session/update → plan` | `plan.snapshot` | 全量替换式（ACP plan 为整体快照） |
| `session/update → available_commands_update` / `current_mode_update` | `session.meta` | 节点头信息 |
| `session/prompt` 响应 stopReason | `node.finished / node.cancelled / node.failed` | 终态 |
| agent 子进程 stderr（按行） | `log.lines` | 原始日志通道，与结构化事件并行 |

## 4. 工作流模型与编排引擎

### 4.1 定义格式（YAML，版本化）

```yaml
meta:
  name: weekly-report
  version: 3

params:                       # 全局参数，启动 run 时可在 UI 覆盖
  week: "2026-W38"

nodes:
  - id: collect
    type: agent
    agent: enterprise
    prompt: |
      收集 {{ params.week }} 的数据并输出 JSON：{"ok": bool, "data_path": str}
    output_schema:                    # 内联 JSON Schema；抽取失败按节点失败处理
      type: object
      required: [ok, data_path]
      properties: { ok: {type: boolean}, data_path: {type: string} }

  - id: analyze
    type: agent
    agent: enterprise
    prompt: "基于以下数据做分析：\n{{ nodes.collect.output }}"

  - id: report
    type: agent
    agent: enterprise
    prompt: "生成周报，数据：{{ nodes.analyze.output }}"
    retry: { max: 2, backoff_ms: 3000 }
    timeout_ms: 600000

edges:
  - { from: collect, to: analyze }
  - { from: analyze, to: report, when: "output.ok == true" }   # 条件边：等值/包含
```

- 变量注入：`minijinja`；作用域为 `params` + `nodes.<id>.output`（上游完成节点的结构化输出或末条消息文本）。
- 条件边表达式仅支持：`output.<path> == <literal>`、`output.<path> contains <literal>`、`and` 组合；`output` 指代该边 `from` 节点的输出。不引入通用表达式引擎。
- 节点的 `output_schema` 为内联 JSON Schema（见 4.1 示例）；抽取失败（末条消息不含合法 JSON 或校验不过）按节点失败处理并保留原始消息于事件。
- 条件不满足的边导致下游节点 `skipped`（其子孙随之 skipped）。
- 并行 = 多条出边天然并发；无显式 parallel 节点。

### 4.2 执行器语义

- tokio 任务图：节点在前驱全部终态后调度；`agent` 节点占一个执行槽（全局并发上限可配，默认 4，防企业 agent 过载）。
- 节点重试：`retry.max` 次指数退避，重试产生 `node.retry` 事件。
- 节点超时：`timeout_ms` 触发 `session/cancel` + 节点 `failed(timeout)`。
- Run 级取消：所有运行中 session 依次 `session/cancel`，未启动节点 `skipped`，run 终态 `cancelled`。
- 引擎崩溃/服务重启：运行中的 run 与节点标记 `interrupted`（事件 `run.interrupted`），不自动续跑；"从失败节点重跑"为二期。

## 5. 事件模型与存储

### 5.1 统一事件

```jsonc
{
  "seq": 42,                       // run 内严格自增，SSE 续传游标
  "ts": "2026-09-22T10:31:02.412Z",
  "run_id": "run_8f3a",
  "node_id": "analyze",            // 引擎事件可为 null（run 级）
  "session_id": "sess_c1",         // 有则填
  "kind": "tool.update",
  "payload": { ... }               // 按 kind 定义，见 3.4 与 6.2
}
```

- kind 语义对齐 AG-UI 事件分类（run/node 生命周期、msg 流、tool 流、plan/state、自定义 log）。
- payload 预留 OTel GenAI 风格属性位：`duration_ms`、`token_usage`(in/out)、`model`——ACP v1 不提供 token 用量，字段定义但常空，供二期 ACP v2 或代理层填充。
- 事件表**只追加**；节点状态、瀑布图、消息文本全部是事件的纯投影，不落第二份状态。

### 5.2 SQLite schema（要点）

```
workflows(id, name, version, yaml, created_at)
runs(id, workflow_id, params_json, status, started_at, ended_at)
events(run_id, seq, ts, node_id, session_id, kind, payload_json)   -- PK(run_id, seq)
sessions(id, run_id, node_id, agent_key, acp_session_id)
artifacts(run_id, node_id, name, content_type, content)            -- 节点结构化输出/大文本
```

- `rusqlite` + bundled SQLite，WAL 模式，单文件（默认 `~/.flowscope/flowscope.db`）。
- 追加路径批量写（每 flush 窗口 ≤50ms 或 ≤64 条），读路径内存缓存 run 投影。

### 5.3 服务器内存通道

每个 run 一个 `tokio::sync::broadcast` 通道（容量 1024，落后者从 SQLite 补读）+ 环形缓冲近期 4096 条用于 `after=<seq>` 快速续传。

## 6. API 设计

### 6.1 REST（前缀 `/api`，Bearer token：服务器模式必填，桌面模式跳过）

```
GET    /workflows                      列表
POST   /workflows                      上传/更新 YAML
GET    /workflows/:id                  详情（含解析后的图结构）
DELETE /workflows/:id
POST   /workflows/:id/runs             启动 run（body: params 覆盖）
GET    /runs?workflow_id=&status=      运行列表
GET    /runs/:id                       详情（节点终态投影）
POST   /runs/:id/cancel                取消
GET    /runs/:id/artifacts/:node
GET    /agents                         agent 注册表 + initialize 探测状态
POST   /agents/:key/probe              手动拉起探测 initialize 后关闭
```

### 6.2 SSE

```
GET /api/runs/:id/events?after=<seq>   # Last-Event-ID 头等价于 after
```

一个端点统一三种语义：live 跟随（after=当前最大 seq）、断线续传（after=客户端已收最大 seq）、全量回放（after=0）。事件 `id:` 字段即 `seq`。

## 7. 前端设计

### 7.1 视图

1. **运行监控（核心视图）**
   - React Flow 画布渲染工作流 DAG（布局：dagre ELK，自动分层）。
   - 节点状态机着色：`pending` 灰 / `running` 蓝 + 脉冲 / `succeeded` 绿 / `failed` 红 / `cancelled` 橙 / `skipped` 灰虚线 / `interrupted` 紫；running 节点显示已运行时长与活动工具名。
   - 点击节点 → 右侧抽屉，五个 tab：
     - **消息流**：agent 消息增量实时拼接（reasoning 折叠块）；自动跟随滚动，上滚暂停。
     - **工具时间线**：tool_call 列表，含状态徽标、耗时、diff 内容块渲染。
     - **Plan**：ACP plan 快照的子任务清单（状态图标）。
     - **原始日志**：`log.lines` 虚拟滚动（react-window），级别着色。
     - **输入/输出**：渲染后 prompt、结构化输出 artifact。
2. **瀑布时间线**：每节点一行横条（起始=首事件 ts，宽度=duration），失败节点红色标因；点击跳抽屉。
3. **运行历史与回放**：run 列表 → 详情页加载全量事件，前端按 seq 滑杆截断重放投影（与服务端投影函数语义一致的前端 reducer）。
4. **工作流配置**（分两阶段）：
   - M1：YAML 编辑器（校验+错误定位）+ 表单式节点属性编辑 + 只读画布预览。
   - M2：**完整画布图形编辑器**——节点面板（palette）拖入新增 `agent` 节点、连线把手拖拽建边/删边、节点内联属性面板（prompt 模板、retry/timeout、output_schema）、条件边表单化编辑、撤销/重做（zustand temporal）。YAML 始终是存储与交换格式：图形侧修改后重新序列化导出，**YAML 注释不保留**（结构字段全量保留）；从 YAML 导入则无损渲染。

### 7.2 状态管理

- SSE 事件 → zustand store 的 `applyEvent` reducer（唯一写入点）→ 派生节点状态/消息缓冲/工具列表。
- reducer 为纯函数，与回放共用（回放=批量 apply 历史事件）。
- 断线处理：`EventSource` 自动重连带 `after=lastSeq`，重连期间 UI 显示"重连中"横幅。

## 8. 配置、安全与脱敏

- `~/.flowscope/config.toml`：db 路径、并发上限、服务器绑定地址、token、日志级别。
- 服务器模式首启生成 256-bit 随机 token 写入 config 并打印一次；REST 校验 `Authorization: Bearer <token>`，SSE（`EventSource` 不能带 header）校验 `?token=` 查询参数，二者取其一即可通过。
- agent 凭据只经环境变量/文件注入子进程，不落库、不进事件。
- 脱敏 hook：config 中正则规则列表（如 API key 模式），事件入库前对 `msg.delta`/`log.lines` payload 应用替换；默认空。

## 9. 错误处理

| 故障 | 行为 |
|---|---|
| agent 子进程崩溃 / stderr 关闭 | 节点 `failed(process_exit)`，stderr 尾部 200 行入 `log.lines`；引擎按 `on_node_failure: abort_run \| continue_independent`（workflow 级配置，默认 abort） |
| initialize 失败 / 探测失败 | agent 注册表标记 unhealthy，UI 徽标；启动 run 时直接拒绝并给出原因 |
| 服务重启 | 运行中 run/node 标记 `interrupted`；历史可回放 |
| SQLite 写失败 | run 标记 `degraded`（事件仅内存广播），UI 顶部警告 |
| SSE 客户端落后 broadcast 容量 | 自动降级从 SQLite 补读缺失区间 |

FlowScope 自身日志：`tracing` → 滚动文件 `~/.flowscope/logs/`，与业务事件流分离。

## 10. 测试策略

- **flowscope-mock-agent**（测试核心资产）：脚本驱动（YAML 行为脚本：延时消息 chunk 序列、工具调用状态机、plan 演化、按 prompt 内容分支、注入崩溃/超时/拒绝）。它本身按 ACP agent 角色实现，顺带验证我们使用的 crate 面。
- `flowscope-core` 单测：DAG 调度（拓扑/条件跳过/并行上限/重试退避/超时取消）、事件映射（ACP update → kind 转换表逐条）、投影函数（事件序列 → 节点终态）、SSE 续传（after 边界：0/中间/超尾）。
- 前端：Vitest 测 reducer 纯函数；组件测试覆盖抽屉五 tab 渲染。
- E2E：Playwright 驱动 Web 版连 mock-agent 全流程（启动 run → 节点依次点亮 → 抽屉内容 → 回放滑杆）。
- 桌面冒烟：CI（GitHub Actions）matrix 打包三平台，启动即截屏比对。

## 11. 里程碑

| 里程碑 | 内容 | 完成标志 |
|---|---|---|
| **M1 核心闭环** | core（ACP 接入 + 引擎 + 存储 + SSE）+ mock-agent + 运行监控视图 + Tauri 桌面内嵌模式 | 真实企业 agent（或 mock）在桌面版完整跑通 YAML 定义的 3 节点工作流，节点实时点亮、抽屉五 tab 可用 |
| **M2 服务器、Web 与编辑器** | flowscope-server + Web 版静态托管 + token + 运行历史/回放 + 瀑布图 + 画布图形编辑器 | 服务器远程跑 run，浏览器免安装围观与回放；工作流可在画布上完成增删节点、拖线连边、条件边配置并导出 YAML |
| **M3 二期候选**（不承诺） | HITL 审批 UI、节点级断点续跑、多 run 对比、ACP v2 | — |

## 12. 风险

| 风险 | 缓解 |
|---|---|
| 企业 agent 的 ACP 包装质量未知（update 稀疏、plan 缺失、tool_call 状态跳跃） | mock-agent 覆盖"稀疏/缺失"行为脚本；UI 对缺失类型降级显示（无 plan tab 则隐藏） |
| `agent-client-protocol` crate 的 v2 feature 不稳定 | 全部代码走 v1 稳定面；crate 升级锁定 minor |
| ACP 远程（HTTP/WS）仍在草案 | 我们不依赖：FlowScope 服务器与 agent 同机部署，跨网络走自研 HTTP/SSE |
| Windows 下 stdio 编码/行缓冲问题 | mock-agent 与真实 agent 均以 UTF-8 无缓冲行输出验证；tracing 记录原始帧 |
| 大 run（10 万+事件）前端卡顿 | react-window + 消息缓冲上限（超出折叠为"加载更多"）+ 回放走分页拉取 |
