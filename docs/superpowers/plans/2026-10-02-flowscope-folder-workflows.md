# FlowScope 文件夹工作流页（git 团队流）实施计划

> For agentic workers: 两个实现提交（后端/前端）+ README，一个实现者顺序完成；随后评审、浏览器验收、合入推送。

**分支** feature/folder-workflows（自 main b6e27f1）。目标：侧边栏新增「工作流文件夹」页——输入磁盘目录，读取其中 `*.yaml/*.yml` 工作流文件，按**名称字母序**展示（名称/版本/文件/解析状态），一键「在编辑器打开」（载入画布编辑器，可保存进 FlowScope 并运行）。默认初始目录可配置。场景：团队把工作流 YAML 放 git 仓库管理，FlowScope 从文件夹读取。

## T1 后端：文件夹读取 API

**Files:** `crates/flowscope-core/src/api.rs`（handler + 解析 + 默认目录）+ 测试。

- `GET /api/fs/workflows?dir=<可选>`：
  - 目录解析 `resolve_dir(dir: Option<&str>) -> PathBuf`：显式 dir → env `FLOWSCOPE_WORKFLOW_DIR` → `<home>/.flowscope/workflows`（`FLOWSCOPE_HOME` home 变量体系一致——读 api.rs 现有 home 逻辑，bootstrap 用传入 home，这里独立读 env/USERPROFILE，保持一致即可）。
  - 目录不存在 → 400 `{"error":"目录不存在: <path>"}`；是文件非目录 → 400。
  - 列出扩展名 `.yaml`/`.yml`（大小写不敏感）的文件，逐个读取文本，用 `workflow::parse_yaml` 提取 `name/version`（不跑 validate；parse 失败 → `valid:false, error:解析错误消息, name 取文件名去扩展名`）。
  - 排序：按 `name.to_lowercase()` 字母序（用户要求）。
  - 响应 `{"dir": "<解析后的目录>", "files": [{"file":"a.yaml","name":"Alpha","version":1,"valid":true,"error":null,"yaml":"<全文>"}]}`。
- bootstrap：`create_dir_all` 默认目录；**仅当目录刚创建（首启）**时种子一个 `hello-zcode.yaml`（agent zcode、prompt 建文件演示——与已验证的冒烟一致）。
- 无状态 handler（纯 fs 读），不进 AppState；router 注册一条。
- 测试：临时目录 3 文件（b.yaml→name"beta"、a.yaml→name"Alpha"、c.yml 非法 YAML）→ 返回按 Alpha<beta 排序、非法项 valid:false 带 error；目录缺失 → 400；resolve_dir 优先级直测（显式 > env > 默认；env 测试注意全局态——其他测试不读该 env，可接受）。
- 安全注记（代码注释）：本地单人工具，目录来自用户输入属预期行为；只读列目录+读文件，无写入端点。

Commit: `feat(core): 文件夹工作流读取 API（默认目录可配置 FLOWSCOPE_WORKFLOW_DIR）`

## T2 前端：文件夹页 + 编辑器导入

**Files:** `frontend/src/api/client.ts`、`frontend/src/views/FolderWorkflows.tsx`（新）、`frontend/src/App.tsx`（路由 `/folder` + 侧边栏项，icon=文件夹 svg，放「工作流」之后）、`frontend/src/views/WorkflowDetail.tsx`（导入入口）、`frontend/src/styles.css`、测试。

- client.ts：`FolderWorkflow{file,name,version,valid,error?,yaml}` + `listFolderWorkflows(dir?: string): Promise<{dir: string; files: FolderWorkflow[]}>`（GET，dir encodeURIComponent，省略则用后端默认）。
- FolderWorkflows 页：
  - 头部「工作流文件夹」+ 说明行（团队 git 管理场景一句话）；
  - 目录输入（label「目录路径」）+「读取」按钮；初次挂载：localStorage 有 `fs-workflow-dir` 用之，否则无 dir 调 API 取后端默认并回填输入框；读取成功后把 dir 写 localStorage；
  - 列表（表格或卡片，后端已排序）：名称 / v版本 / 文件名 / 状态徽标（✓ 可用 | 解析失败，失败项 title 显示 error）/「在编辑器打开」按钮（valid 与否都可打开——失败项进编辑器可修）；
  - 「在编辑器打开」→ `navigate('/workflows/new', { state: { importedYaml: f.yaml } })`；
  - 错误（400 目录不存在）显示 fs-error-text。
- WorkflowDetail：isNew 挂载时若 `location.state?.importedYaml` 为字符串 → `loadYaml(importedYaml)`（替代 loadBlank；与现有 StrictMode 幂等守卫合并）；**导入路径必须跳过种子 agent 交换 effect**（加 ref 标记 importedRef，交换 effect 首行 return）——导入的 YAML 是权威内容。保存行为不变（保存进 FlowScope 数据库）。
- 测试：FolderWorkflows.test.tsx（mock client：排序展示、读取按钮触发带 dir 的调用、点击打开 navigate 带 state、目录错误显示）；WorkflowDetail.test.tsx 补一条（带 state 的 new → model 为导入内容而非 blank）。
- README 用户指南：1.2 后加「从文件夹读取工作流（git 团队流）」小节——默认目录 env `FLOWSCOPE_WORKFLOW_DIR`、首启种子 `~/.flowscope/workflows/hello-zcode.yaml`、页面用法、注意（只读读取；编辑后「保存」进 FlowScope 数据库，回写文件夹请走 git 提交流程）。

Commit: `feat(frontend): 工作流文件夹页——目录读取/字母序列表/一键进编辑器`

## 验收（控制台）

真实目录建 2-3 个 YAML（乱序文件名），浏览器：侧边栏新页 → 输入目录读取 → 字母序展示 → 点开进编辑器 → 保存启动。合入 main 推送。
