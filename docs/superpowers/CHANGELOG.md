# FlowScope 交付日志（Changelog）

按时间序记录各次交付；细节见对应计划/报告与 `specs/2026-10-02-flowscope-current-state.md`（现状权威文档）。

## 2026-10-18 · 中文模板修复 + 存储保留期（`fix(core): 渲染器兼容非 ASCII 标识符（中文节点 ID/参数名点访问自动转下标）` + `feat(core): FLOWSCOPE_RETENTION_DAYS 存储保留期（含级联清理）`）
- **渲染器兼容非 ASCII 标识符（fix）**：minijinja 点语法只认 ASCII 标识符——中文节点 ID/参数名（`{{ nodes.取数.output.数据 }}`、`{{ params.主题 }}`）解析期报 `unexpected character` → node.failed → run 失败（已现场复现锁定）。`render_prompt` 渲染前经 `render::preprocess_non_ascii_attributes` 纯函数预处理：只在 `{{ }}`/`{% %}` 表达式内，把「非合法标识符（且非纯数字，保护 `1.5`/`list.0`）」的点访问段改写为等价下标 `["…"]`；连字符 id（`nodes.my-id.x`）同样受益，base 非法（`{{ my-id.x }}`）时后续段一并下标化；引号字符串（含转义）/既有 `["…"]`/普通文本/`{#注释#}` 不动；纯 ASCII 模板逐字节不变（零回归面）。
- **FLOWSCOPE_RETENTION_DAYS 存储保留期（feat）**：env 设正整数 N 时，bootstrap 开库后执行 `store.prune_runs_before_days(N)`——事务内删除 `started_at` 早于 N 天的 runs 并按 delete_workflow 同款子查询级联删 events/artifacts/sessions，返回删除条数并 `tracing::info`；0/未设=禁用（永久保留），非法值 warn 忽略继续启动。桌面/浏览器/独立 server 三形态共用 bootstrap，一并生效。
- 测试：cargo **65**（63 lib + 2 e2e；+6：预处理/端到端中文渲染 5 + prune 级联与幂等 1）；前端 specs 未动（纯后端改动）。文档同步（现状文档 §1/§2/§4/§5、README 1.4）。

## 2026-10-09 · fix: 访问令牌仅保护 /api——静态资源放行（`fix(core): 访问令牌仅保护 /api——静态资源放行（修复浏览器白屏）`）
- **缺陷**：令牌中间件覆盖全部路径——浏览器经 `/?token=` 拿到 HTML 后，`<script>/<link>` 标签裸取 `/assets/index-*.js|css`（无法携带凭据）→ 401 → 白屏。curl 冒烟只测了 `/` 与 `/api`，未暴露。
- **修复**：`auth_middleware` 开头路径分流——非 `/api` 一律放行（`/`、`/assets/*`、favicon、SPA 回退；静态资源不含密钥）；`/api`（全部方法）仍须 Bearer 或 `?token=`，401 body 不变；token=None 全透传不变。页面内 API 调用由前端 client 统一附加 `?token=`。
- **测试矩阵改写**：`GET /`（无 token）→ 200（页面公开）；新增回归——**无 token GET 真实 `.js` 嵌入键 → 200**（正是浏览器白屏场景）；`/api` 无凭据 401、错误/空 token 401、`?token=`/Bearer 放行均保持。
- 验证：cargo 59 全绿 + release exe 复冒烟（`/?token=` 200 → html 内 js 资源**不带 token** 200 → `/api/agents` 无 token 401 → 带 token 200）+ e2e 4/4；文档同步（现状文档 §1/§2、README 1.4）。

## 2026-10-09 · 独立二进制分发：嵌入 UI + 访问令牌 + flowscope-server（T1 `feat(core): 前端资源嵌入与访问令牌中间件` + T2 `feat: flowscope-server 独立服务器 bin 与 release 分发构建（嵌入 UI/随机令牌/静态 CRT）`）
- **前端资源嵌入（T1）**：`crates/flowscope-core/build.rs`——dist 缺失时写占位 index.html 防编译失败；`src/assets.rs` rust-embed 编译期嵌 `frontend/dist`（`debug-embed` 使 dev/test 与 release 同路径），`serve_embedded` MIME 小表（按最后段扩展名）+ `..` 拒绝；`router_with_static` 的 `dist=None` 语义=嵌入兜底（`/` SPA 回退、`/assets/*` 精确匹配），dev bin 传 `Some(dist)` 磁盘优先不变。
- **访问令牌（T1）**：`AppState`/router 增 `token: Option<Arc<str>>`——Some 时所有请求（API+静态）须 `Authorization: Bearer` 或 `?token=`，否则 401 `{error:"unauthorized"}`；None 完全透传（桌面/dev 零影响）。
- **flowscope-server bin（T2）**：`crates/flowscope-core/src/bin/server.rs`——参数 `--port`（8080）/`--home`（~/.flowscope）/`--token`（缺省自动 16 hex 随机生成并打印，std-only 熵源）/`--workflow-dir`；mock agent 探测 exe 同目录 → target/debug；启动打印本机全部 IPv4 的 `http://<ip>:<port>/?token=<t>` 逐行。
- **桌面壳（T2）**：`main.rs` 改传 `dist=None`（嵌入 UI；窗口/端口逻辑不变）。
- **CRT 静态链接（T2）**：仓库根 `.cargo/config.toml` 全局 `+crt-static`（release+dev 全量重编译一次）——desktop/tauri 链接正常，未走 per-bin RUSTFLAGS 退化路线；release exe 导入表仅系统 DLL（无 VCRUNTIME140）。
- **release 冒烟**：干净临时目录仅两 exe（server 14.8MB + mock-agent 0.6MB）跑 `--port 39330`——无 token `/api/agents` 401、`/?token=` 200 含 FlowScope、`/api/agents?token=` 200 JSON、POST 单节点 mock 工作流启动运行至 `finished`（节点产物可取）；desktop release exe 22.6MB 存在性检查（GUI 未跑）。
- 测试：cargo 59（+2：嵌入可达/..拒绝、token 401/双携带方式/透传回归）/ vitest 158 / e2e 4/4（specs 未动）。

## 2026-10-08 · 保存到文件夹通用化：另存派生 + 文件夹页派生（`feat(frontend): 保存到文件夹通用化——另存到文件夹（目录/文件名/标记派生）` + `feat(frontend): 文件夹页派生——从既有工作流快速另存新文件（含文档同步）`）
- 编辑器：「**保存到文件夹**」常驻任何工作流工具栏（此前仅文件夹 origin 入口显示）——有 effectiveOrigin（location.state origin 或本地 savedOrigin）一键写回；无则弹 `fs-folderdlg` 对话框（目录预填 localStorage `fs-workflow-dir` → 后端默认目录，文件名=model.name 合法化补 `.yaml`，缺后缀保存时自动补）。旁新增同级「**另存到文件夹…**」（一等 Save As，常驻、总弹对话框，预填 effectiveOrigin ?? 同上默认）。
- 对话框「**标记**」字段（初值=画布 tags join）：与画布 tags 不同时对 `toYaml()` 结果做 `setYamlTags` 文档手术再保存——**文件派生 tags、画布 model 不动**；成功更新 savedOrigin（主按钮后续一键直达新路径）+ toast + 失效 `['folder-workflows']`，失败对话框保留就地显错；预检（目录/文件名非空、无 `/` `\`）不发请求。
- 文件夹页：每行「**派生**」按钮（`data-testid="derive-<file>"`，valid:false 禁用同「标记」）打开 `fs-folderdlg` 对话框——文件名预填 `<stem>-copy` 保留源 `.yaml`/`.yml` 扩展名、标记预填源 tags、目录=resolvedDir；保存=对**源文件 yaml 原文**做手术（标记有变时，注释保留）→ `saveFolderWorkflow` 写新文件（源文件不动）→ 重载列表即时出现（可能进新分组）。
- 测试：vitest 154（+12：编辑器对话框预填/派生标记/直存切换/后缀/预检、文件夹页派生全链路）/ e2e 4/4（specs 未动）。

## 2026-10-08 · 文件夹页行内标记编辑——tags 就地增删、保留注释回写（`feat(frontend): 文件夹页行内标记编辑——tags 就地增删、保留注释回写（含文档同步）`）

## 2026-10-18 · 中文链路两连修：message 累积根因 + 提取候选扫描（9c95c7d + d3769b8）
- 根因修复：真 ZCode 桥给正文块标 `messageId: msg_*`、给尾注标 `turninfo_*`，旧累积按 messageId 分组且 id 变化即整体覆盖——尾注抹掉正文（实测 135→56 字符）。改为无条件追加累积，兼容数组内容块，mock-agent 扩展 thought/message_id/message_array 字段做回归。
- 结构化输出提取改候选扫描：整段 trim → 围栏块 → **从右向左平衡对象扫描**（字符串感知），优先取最后可解析且过 schema 的 JSON——解决思考回显 JSON 模板污染首尾切片的问题；失败附消息长度+尾部诊断。
- 测试基线：cargo **71**（69 lib + 2 e2e）。

## 2026-10-02 · 文件夹页增强：分类标记 / 保存路径 / 刷新（e8d916c + `feat(frontend): 文件夹页分类标记与分组收起、编辑器保存回文件夹、刷新（含文档同步）`）
- 后端：`WorkflowDef`/`RawMeta` 增 `meta.tags`（`Option<Vec<String>>`，不进引擎语义，编排忽略）；`GET /api/fs/workflows` 条目带 `tags`（缺省空数组）；新 `POST /api/fs/workflows/save` `{dir,file,yaml}`——目录存在/文件名防穿越+`.yaml|.yml`/YAML 可解析三层 400 校验后覆盖写回，响应 `{dir,file,bytes}`。
- 前端：文件夹页按**首个 tag** 分组（组名集合字母序、「未分类」恒最后、组内名称不区分大小写排序），组行 ▶/▾ 展开/收起（localStorage `fs-folder-collapsed` 按目录记忆），行 tag 小徽标，「刷新」重读当前目录；「在编辑器打开」带 originDir/originFile → 编辑器 new 页「保存」旁多「**保存到文件夹**」按钮（校验门与保存一致、先 blur 冲刷，成功 toast「已保存到 <file> ✓」）；工作流设置「标签」输入（中英文逗号切分 trim 去空，空=删字段），YAML meta 键序 name/version/tags。
- 测试：cargo 57（+4）/ vitest 132（+12）/ e2e 4/4（specs 未动）。

## 2026-10-02 · 工作流文件夹页（9a4ce1d / 424ea3f / 18142f0）
- 侧边栏「文件夹」页：读取磁盘目录 `*.yaml/*.yml`，按名称字母序展示（名称/版本/文件/解析状态），一键载入画布编辑器（importedYaml 经 location.state，种子交换跳过）。
- `GET /api/fs/workflows?dir=`；默认目录 `FLOWSCOPE_WORKFLOW_DIR` → `~/.flowscope/workflows`（首启种子 hello-zcode.yaml）；前端 localStorage 记忆目录。
- 解析失败文件：YAML 层自动展开原文+错误，修复后「应用到画布」。
- README「git 团队流」小节；测试 cargo 53 / vitest 120 / e2e 4/4。

## 2026-10-02 · UX 微调三则（27f3ff4 / 7cc1fad / 1709c66 / b6e27f1）
- agent 面板隐藏内置演示 agent（mock/bad-mock；属性面板下拉不过滤——存量 mock 工作流可编辑）；新建种子节点自动换首个非演示 agent。
- 新节点默认预填 retry 2/退避 3000/超时 600000（工作流设置可调；0=省略字段；编辑器偏好不进历史）。
- 思考亲和归类：会话视图+抽屉单一 details 默认收起，摘要「N 段 · 共 X 字」。
- 附带裁决：e2e build-via-canvas 选择器换 palette-add-zcode、辅助函数显式设 step1=mock（真桥拒空 prompt）。

## 2026-10-02 · M2c：ZCode ACP 接入 + 节点会话视图（04733c0 / 09b2c28 / 00d564a）
- 后端：bootstrap 自动注册 ZCode 桥 agent（ZCODE_NODE/ZCODE_BIN/ZCODE_ACP_BRIDGE/ZCODE_ACP_RUNTIME）；model 配置（session/new 后、prompt 前 set_config_option；缺省选首个非 start-plan）；渲染后 prompt 进 node.started。
- 前端：节点会话视图 `/runs/:runId/sess/:nodeId`（用户气泡/思考折叠/工具卡/stop chip/协议事件抽屉；SSE 回放+实时统一；useRunEvents 增 onEvent 旁路）；画布节点消息预览行。
- 真机验收：真 ZCode 30s 建文件跑通（26 delta/Write 工具链）。

## 2026-10-02 · 节点紧凑化（87c4694）
- 节点卡宽度内容自适应（212→约 104px）+ fitView maxZoom 1（防小图放大）。

## 2026-09-24 · 保存体验与点击感（3f70521 / 2d3ed7c）
- Ctrl+S 保存（先冲刷输入）、脏态高亮保存钮、成功 toast、未保存离开拦截（useBlocker→createBrowserRouter 迁移）；palette 整行可点+节点落场动画（仅动画内容区，handle 几何恒定）。

## 2026-09-24 · M2a：画布图形编辑器（d18ea46..a3efb47，8 任务）
- 可编辑 DAG（palette 拖入/添加、拉线连边、节点拖移）、PropertyPanel 三态表单、快照撤销重做、YAML 源码层双向、yaml@2 替换脆弱扫描器、前端校验镜像后端、画布搭建 e2e×2。
- 用户交互自 M2a 起为**图优先**（YAML 退居存储/交换格式）。

## 2026-09-24 · 深色可观测主题（7edce1a）
- 深色主题全量改版（品牌侧栏/状态圆点徽章/点阵画布/抽屉打磨），CSS 变量化；README 界面预览。

## 2026-09-23/24 · M1 核心闭环（bea5783..ed0be82，16 任务+终审修复）
- flowscope-core（ACP 客户端/DAG 引擎/SQLite 事件溯源/REST+SSE）、flowscope-mock-agent、React 监控前端、Tauri 2 壳、Playwright e2e、README 用户指南。
- 终审 SHIP-WITH-LIST 两项 MUST-FIX（redact 纯函数交付、SSE Lagged 断流重连）+ 桌面 tracing。

## 文档体系
- 历史设计：`specs/2026-09-22-flowscope-design.md`（M1 spec，含 M2 编辑器修订）
- 各里程碑计划：`plans/`（M1、M2a、M2c、UX 三则、文件夹页；m2/m2b-backlog 已被现状文档收编，仅作历史）
- **现状权威文档：`specs/2026-10-02-flowscope-current-state.md`**——整体修改从它出发。
