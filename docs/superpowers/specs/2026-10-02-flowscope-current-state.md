# FlowScope 系统现状（Current State）

- 日期：2026-10-02 ｜ 对应 main：`18142f0` ｜ 远端：https://github.com/SanfuZ/flowscope（私有）
- 定位：**后续整体修改的单一权威参考**。历史设计（M1 spec）与各里程碑计划保留在原处作记录；本文档描述系统**当前实际行为**。改动落地后请同步更新本文档。
- 测试基线：cargo **59**（57 lib + 2 e2e）· vitest **158** · Playwright e2e **4/4**。命令：`cargo test -p flowscope-core`、`cd frontend && npm test -- --run && npm run e2e`。

## 1. 功能总览

| 子系统 | 现状 |
|---|---|
| ACP 接入 | 官方 `agent-client-protocol` crate 2.2（Client 角色，v1 稳定面）；agent 经 `agents.toml` 注册（command/cwd/env/model/permission_default）；内置演示 agent `mock`/`bad-mock`；**ZCode 经 zcode-acp-server 桥自动注册**（见 §4） |
| 工作流引擎 | YAML DSL（meta（含可选 `tags` 标记，编排忽略）/params/on_node_failure/nodes[id,agent,prompt,output_schema,retry,timeout_ms]/edges[from,to,when]）；Kahn 拓扑+条件边（==/contains/and）+层内并行（Semaphore 4）；重试退避/超时/取消/跳过级联；minijinja Strict 模板（`{{ params.x }}`、`{{ nodes.<id>.output.<path> }}`）；output_schema 结构化提取 |
| 事件溯源 | SQLite（WAL）单文件 `~/.flowscope/flowscope.db`；表 workflows/runs/events/sessions/artifacts；事件只追加，节点状态=事件投影；每 run 内 seq 严格递增 |
| 实时通道 | SSE `GET /api/runs/:id/events?after=<seq>`（Last-Event-ID 等价）；hub=broadcast(1024)+ring(4096)；**Lagged → 断流促重连回补**；EventSource 自动重连（1s→10s 退避） |
| 桌面/部署 | Tauri 2 壳（进程内嵌引擎，随机端口，`FLOWSCOPE_DESKTOP_PORT` 可固定，**静态资源走编译期嵌入**）；dev 启动器 `bin/dev`（39271，磁盘 dist 优先）；**独立无头服务器 `bin/server`（flowscope-server.exe）**——前端 UI 嵌入 exe、随机访问令牌、打印本机 IPv4 入口 URL；bundle.active=false（未出安装包） |
| 安全边界 | 单人本地工具；dev/桌面无 token 完全透传；**分发形态（flowscope-server）恒启用随机令牌**——所有请求须 `Authorization: Bearer <t>` 或 `?token=<t>`，否则 401（见 §2）；fs 回调白名单=canonicalize 后 cwd 比较；文件夹 API 列表只读 + save 端点限定目录内 `.yaml/.yml` 文件名（防穿越） |

## 2. 后端 API（前缀 /api，同源）

| 路由 | 说明 |
|---|---|
| `GET/POST /workflows` | 列表 / 保存（body `{yaml}`，parse+validate 后入库，400 带中文错误） |
| `GET/DELETE /workflows/{id}` | 详情（含 yaml 原文）/ 删除（级联 runs/events/artifacts） |
| `POST /workflows/{id}/runs` | 启动运行（body `{params}`；引擎合并 params 于默认值） |
| `GET /runs`、`GET /runs/{id}` | 运行列表（可按 workflow_id/status 过滤）/ 详情 |
| `POST /runs/{id}/cancel` | 取消（仅本进程内 run；跨重启 404） |
| `GET /runs/{id}/events?after=` | SSE：事件 `id:`=seq、`event: fs`、KeepAlive 15s；after=0 即全量回放 |
| `GET /runs/{id}/artifacts/{node}/{name}` | 节点产物（每成功节点有 `output`） |
| `GET /agents` | 注册表（key/name/permission_default/healthy——healthy 恒 true，探活未实现） |
| `GET /fs/workflows?dir=` | **文件夹读取**：列 `*.yaml/*.yml`，parse 取 name/version/**tags**（失败→valid:false 回退文件名；tags 缺省空数组），按 name.to_lowercase() 字母序；目录缺失 400 `目录不存在` |
| `POST /fs/workflows/save` | **保存到文件夹**（body `{dir, file, yaml}`）：dir 存在且为目录、file 无路径分隔符且 `.yaml/.yml` 结尾（防穿越）、yaml 可 parse（三层 400 校验）→ 覆盖写 `dir/file`，响应 `{dir, file, bytes}` |

- 默认 agents.toml / 工作流文件夹种子：bootstrap 首启生成（`~/.flowscope/agents.toml`、`~/.flowscope/workflows/hello-zcode.yaml`——**已存在的文件不覆盖**，改默认模板需删文件重启）。
- **访问令牌**：`bootstrap` 的 `token=Some(t)` 时（flowscope-server 分发形态恒启用；dev/桌面传 None），**所有**请求（`/api/*` 与静态资源）须带 `Authorization: Bearer <t>` **或** `?token=<t>`（SSE EventSource 不支持自定义头的场景），否则 401 `{error:"unauthorized"}`；token=None 时完全透传，零影响。
- 可配置 env：`FLOWSCOPE_WORKFLOW_DIR`（文件夹页默认目录）、`ZCODE_NODE`/`ZCODE_BIN`/`ZCODE_ACP_BRIDGE`/`ZCODE_ACP_CWD`（ZCode 桥路径覆盖，见 §4）、`FLOWSCOPE_DESKTOP_PORT`、`RUST_LOG`。

## 3. 事件契约（payload 键名 camelCase，前后端共用）

| kind | payload 关键字段 |
|---|---|
| `run.started` | workflowName, params |
| `node.started` | **prompt（渲染后，M2c 起）**；渲染失败路径无 prompt |
| `msg.delta` | delta, contentType(text\|reasoning) |
| `tool.update` | toolCallId, title?, kind?, status(pending/in_progress/completed/error), content?（ACP ToolCallContent 信封数组） |
| `plan.snapshot` | entries:[{content,priority,status}]（扁平无 id——ACP v1 实况） |
| `log.lines` | lines[], level（agent stderr 行批） |
| `node.finished/failed/cancelled/skipped` | durationMs, reason?(failed) |
| `node.retry` | attempt(1-based), max |
| `run.finished/failed/cancelled/interrupted` | reason?(failed) |
| `callback` / `permission` | method/allowed/detail；toolCallId/optionId/auto/allowed |

StopReason 5 值映射（acp→NodeFailure）：end_turn→Ok；cancelled→ProcessExit("cancelled")（**注意：现按 Retryable 走重试，行为偏差待修，见 §8**）；refusal/max_tokens/max_turn_requests→Fatal。

## 4. ZCode ACP 接入（本机已实测跑通）

- 事实链：ZCode CLI 无原生 ACP → 社区桥 `zcode-acp-server`（ACP↔ZCode Protocol）→ `zcode.cjs app-server --stdio`。参考 `D:\zcode_processing\zcode-acp-demo\README.md`（协议事实与坑的原始记录）与 `workflow-demo.html`（节点会话视图的交互原型）。
- bootstrap 在桥与 node≥22 文件存在时自动写 agents.toml `zcode` 条目：command=[ZCODE_NODE, 桥cli.js, server]，env 四件套 **`ZCODE_NODE`（≥22 node）/`ZCODE_BIN`（zcode.cjs——缺失报 "zcode not found"）/`ZCODE_ACP_RUNTIME=node`/`ZCODE_ACP_CWD`（默认用户主目录）**，`model='builtin:bigmodel-coding-plan\GLM-5.3-Flash'`（TOML 字面单引号，单反斜杠）。
- model 逻辑：session/new 后、首条 prompt 前，`ActiveSession::connection().send_request_to(Agent, v1::SetSessionConfigOptionRequest)` 发送；cfg.model 缺省时从 config_options 选第一个不含 "start-plan" 的项（**start-plan 无头必败**）；发送失败 warn-and-continue。
- 已知行为：真桥拒绝**空 prompt**（"empty prompt"→重试耗尽失败）；usage_update 未单独事件化（正文里可见）；无 `session/load`（节点内续问为待办）。

## 5. 前端（React 18 + Vite 6 + TS + ReactFlow 12 + zustand 5 + yaml@2）

### 路由与页面
| 路由 | 页面 | 要点 |
|---|---|---|
| `/` | 运行列表 | 3s 自动刷新；耗时列；空态引导 |
| `/workflows` | 工作流列表 | 卡片；「新建工作流」→ /workflows/new |
| `/workflows/:id`（含 new） | **画布编辑器（主交互）** | Palette（隐藏演示 agent mock/bad-mock；整行可点+落场动画）+ 可编辑 DAG（拖入/拉线/删除/拖移）+ PropertyPanel 三态（节点属性/条件边三件套+raw/工作流设置含新节点默认与**标签输入**）+ 撤销重做（快照 50 步，Ctrl+Z/Y，输入框内跳过）+ 校验徽章 + 保存（校验门禁+Ctrl+S+toast+未保存离开拦截 useBlocker）+ **保存到文件夹（通用化）**（常驻按钮：有 effectiveOrigin（location.state origin 或本地 savedOrigin）一键写回该文件；无 → `fs-folderdlg` 对话框选目录/文件名，目录预填 localStorage `fs-workflow-dir` → 后端默认，文件名=model.name 合法化补 `.yaml`）+ **另存到文件夹…**（常驻 Save As：总弹对话框，预填 effectiveOrigin ?? 同上默认；「标记」字段可在保存时**派生 tags**——与画布 tags 不同则对 `toYaml()` 结果做 `setYamlTags` 手术，model 不动）+ YAML 源码滑层（双向，导入失败自动展开原文+错误） |
| `/folder` | 工作流文件夹 | 目录输入+读取+**刷新**（重读当前目录）；localStorage 记忆；**按首个 `meta.tags` 分组**（组名集合字母序、未分类恒最后、组内名称字母序），组行展开/收起（localStorage `fs-folder-collapsed` 按目录记忆），行 tag 小徽标；**行内标记编辑**（行「标记」按钮→行下 `fs-tagpop` 面板，保存=`setYamlTags` 文档手术只改 `meta.tags`（注释/排版保留）+ `saveFolderWorkflow` 写回 + 重载即时重分组；valid:false 行禁用）；**行内派生**（行「派生」按钮→`fs-folderdlg` 对话框：文件名预填 `<stem>-copy` 保源扩展名、标记预填源 tags、目录=resolvedDir；保存=对**源 yaml 原文**做 `setYamlTags` 手术（标记有变时，注释保留）→ `saveFolderWorkflow` 写新文件（源不动）→ 重载列表；valid:false 行禁用）；一键进编辑器（importedYaml + **originDir/originFile** 经 location.state；解析失败自动开 YAML 层） |
| `/runs/:id` | 运行监控 | DAG 状态着色+消息预览行（running 尾 48 字/succeeded ✅）；顶栏 run-status；双击节点→会话视图 |
| `/runs/:runId/sess/:nodeId` | 节点会话视图 | workflow-demo.html 形式：用户气泡(prompt 来自 node.started)/思考折叠块(默认收起，「N 段·共 X 字」摘要)/工具卡/stop chip/协议事件抽屉（onEvent 旁路收集）；SSE after=0 回放+实时统一 |

### 状态与关键 store
- `runStore`：NodeView{status,message,reasoning[],tools[],plan{entries},logs[](cap500),prompt?,error}；applyEvent 纯函数（唯一写入点）；`seq<=lastSeq` 丢弃防重放。
- `editorStore`：文档模型（唯一事实源）+ positions（视图态不持久）+ 快照撤销重做（cap 50）+ `newNodeDefaults{retryMax:2,backoffMs:3000,timeoutMs:600000}`（编辑器偏好：不进历史/不置脏；0=省略字段）+ updateModelMeta（name/version/**tags**/params/on_node_failure）；**新建种子节点自动换首个非演示 agent**（dirty 或导入时跳过）。
- 校验 `lib/validate.ts` 镜像后端规则（id 唯一/边引用/Kahn 环/when 语法）；保存门禁 + 面板就地提示。
- 主题：深色可观测风，全变量化（styles.css `:root`）；UI 文案中文；无 UI 组件库。
- 入口按钮/选择器冻结面：e2e 依赖 `palette-add-zcode`（build-via-canvas 辅助函数显式设 step1=mock——真桥拒空 prompt）、`.fs-node--<status>`、`.fs-monitor`、`drawer-*`、`data-testid="run-status"`、按钮「保存」「启动运行」「在编辑器打开」。

### 静态资源嵌入与分发形态（standalone binary）

- **编译期嵌入**：`frontend/dist` 经 rust-embed 嵌入 flowscope-core（`src/assets.rs`；`debug-embed` feature 使 dev/测试与 release 同走嵌入路径；`build.rs` 在 dist 缺失时写占位 index.html 防编译失败）。`bootstrap`/router 收到 `dist=None` 时静态请求以嵌入资源兜底：`/`→index.html（SPA 回退）、`/assets/*` 精确键匹配、含 `..` 拒绝、MIME 按最后一段扩展名小表（未知→octet-stream）。dev 启动器传 `Some(dist)` 磁盘优先（热更新不变）。
- **flowscope-server**（`crates/flowscope-core/src/bin/server.rs`，`[[bin]] flowscope-server`）：无头单文件服务器。参数 `--port`（默认 8080）/`--home`（默认 `~/.flowscope`）/`--token`（缺省自动生成随机 16 hex 并打印）/`--workflow-dir`（设 `FLOWSCOPE_WORKFLOW_DIR`）。mock agent 探测 exe 同目录 `flowscope-mock-agent.exe` → `target/debug/`；dist 恒 None；启动打印本机全部 IPv4 的 `http://<ip>:<port>/?token=<t>` 逐行 + 令牌提示。
- **桌面壳**：`main.rs` 改传 `dist=None`（嵌入 UI；分发形态本就无磁盘 dist），窗口/端口逻辑不变。

## 6. 关键文件地图

```
crates/flowscope-core/src/
  api.rs            # 全部路由+bootstrap（agents.toml/文件夹种子）+fs_workflows+zcode_spec
  acp/registry.rs   # AgentConfig(model 字段)+agents.toml 解析
  acp/session.rs    # run_agent_node：update→事件映射、回调白名单、model 发送、fs_read_allowed
  engine.rs         # DAG 调度+EventSink(node.started 带 prompt)+AcpExecutor
  events.rs         # FsEvent/EventKind/redact 纯函数（管道接线未做）
  store.rs / hub.rs # SQLite 事件溯源 / broadcast+ring
  workflow.rs / cond.rs / render.rs  # DSL/条件表达式/模板渲染
frontend/src/
  views/{RunList,WorkflowList,WorkflowDetail,RunMonitor,NodeSession,FolderWorkflows}.tsx
  components/{NodeCard,NodeDrawer,PropertyPanel,EditableCanvas,Palette,ProtocolDrawer,StatusBadge,LogList}.tsx
  store/{runStore,editorStore}.ts  api/{client,types,graph,workflowModel,useRunEvents}.ts
  lib/{validate,layout,nodeTypes}.ts
apps/desktop/src-tauri/   # Tauri 壳（bootstrap 复用）
docs/superpowers/         # 本文档体系
```

## 7. 构建与运行

```bash
cargo build -p flowscope-mock-agent && cd frontend && npm install && npm run build && cd ..
cargo run -p flowscope-core --bin dev -- --port 39271 --home target/dev-home \
  --frontend-dist frontend/dist --mock-agent-bin target/debug/flowscope-mock-agent.exe
cargo run -p flowscope-desktop        # 桌面版（home=~/.flowscope）
```

**release 独立分发**（单文件 exe：前端 UI 编译期嵌入 + CRT 静态链接 `.cargo/config.toml`，
目标机免 Node/磁盘 dist/VC++ 运行库；桌面另需系统 WebView2）：

```bash
cd frontend && npm run build && cd ..                 # 先出 dist（嵌入内容）
cargo build --release -p flowscope-core -p flowscope-desktop
# 分发：拷 target/release/flowscope-server.exe（+ 可选 flowscope-mock-agent.exe 同目录）
target/release/flowscope-server.exe --port 8080       # 启动即打印各 IPv4 的 ?token=<随机16hex> 入口
# 可选参数：--home DIR（默认 ~/.flowscope）、--token T、--workflow-dir DIR
```

## 8. 已知限制与遗留待办（合并自 m2-backlog/m2b-backlog，剔除已完成项）

**行为修正候选（优先）**
1. R8 偏差：`stopReason: cancelled` 现走 Retryable 被重试终态 failed，应为 node-cancelled 不重试。
2. 初次载入"后端合法但前端拒收"的 YAML（如 params 非标量）仍静默（文件夹导入路径已修，直接 URL 载入路径未修）；params 非标量透传策略待定。
3. 节点级 interrupted 不可达（重启后节点永远 running 投影）。
4. no-op 失焦/条件边逐键提交推历史+置脏；trio 清值后 raw 显示陈旧。
5. validate 未镜像 u32/u64 整数与范围（version 1.5 等后端才拦）。
6. WorkflowList 空态文案仍提「粘贴 YAML」；空 prompt 建议保存期校验（真桥会拒）。

**M2b 计划承诺**
7. ~~flowscope-server 独立二进制 + bearer token + Web 部署形态。~~（**已交付** 2026-10-09：嵌入 UI + 随机令牌 + CRT 静态链接，见 §1/§2/§5/§7）
8. 运行回放视图（seq 滑杆）+ 瀑布时间线。
9. agent 健康探活（POST /agents/:key/probe + start_run 拒绝 unhealthy）。
10. 桌面安装包（tauri bundle）+ CSP 收紧 + cargo-tauri CLI 进流程。
11. 脱敏接线（config 规则加载+管道应用；`events::redact` 纯函数已备）。
12. sessions 表落库、token_usage/model 字位、并发可配+指数退避、SSE 回填分页、EventHub 淘汰、fs 回调 spawn_blocking、gen/schemas gitignore。
13. `session/load` 节点内续问（会话视图 composer 的前置）。
14. 文件夹页增强候选：从文件夹直接运行（跳过入库）。（「导出回写文件夹」已交付：编辑器「保存到文件夹」按钮 + `POST /api/fs/workflows/save`，见 §2/§5。）

**已接受不修（文档化）**：cond `" and "` 引号不感知；YAML 应用不可撤销；多原子 and 仅 raw 可表达；边 id 含 `->` 极端情形；hub 广播乱序窄窗（页面刷新可恢复）；mock-agent 外观项等。
