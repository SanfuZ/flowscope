# FlowScope 交付日志（Changelog）

按时间序记录各次交付；细节见对应计划/报告与 `specs/2026-10-02-flowscope-current-state.md`（现状权威文档）。

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
