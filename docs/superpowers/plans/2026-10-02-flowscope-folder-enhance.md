# FlowScope 文件夹页增强（分类标记 / 保存路径 / 刷新）

> For agentic workers: 两个实现提交（T1 后端 / T2 前端+文档），一个实现者顺序完成；随后评审、浏览器验收、合入推送。**按归档约定：T2 需同步现状文档与 CHANGELOG。**

**分支** feature/folder-enhance（自 main a4b3905）。目标三件：
1. 文件夹页**分类与标记**：YAML `meta.tags: [A, B]` 作为标记；按**首个 tag** 分组（无 tag → 「未分类」组排最后），组内名称字母序，组行可**展开/收起**（状态记 localStorage），行上显示全部 tag 徽标。
2. **保存路径选择**：从文件夹打开进编辑器的工作流，工具栏多一个「保存到文件夹」按钮——把当前画布内容（含 tags）**写回来源 git 文件夹的同名文件**（POST 新端点），与既有「保存」（进 FlowScope 数据库）并存，用户自选。
3. 文件夹页**刷新**按钮：重读当前目录（保存在同文件夹后可刷新出最新）。

## T1 后端

**Files:** `crates/flowscope-core/src/workflow.rs`、`api.rs` + 测试。

1. `RawMeta` 增 `tags: Option<Vec<String>>`（serde default；deny_unknown_fields 保持）；`WorkflowDef` 增 `pub tags: Option<Vec<String>>`（parse 提升）。**不进引擎语义**（编排忽略 tags），仅供 fs API 与文档保真。
2. `GET /api/fs/workflows`：条目增 `tags: Vec<String>`（空数组缺省）。
3. 新端点 `POST /api/fs/workflows/save`，body `{dir, file, yaml}`：
   - dir 必须存在且为目录 → 否则 400 `目录不存在: <path>`；
   - file 校验：非空、无路径分隔符 `/` `\`、非 `..`、以 `.yaml`/`.yml` 结尾（大小写不敏感）→ 否则 400 `非法文件名`（防穿越）；
   - yaml 先 `workflow::parse_yaml` 校验 → 失败 400（含解析错误消息；编辑器侧已有校验门，此为最后防线）；
   - 写文件（覆盖），响应 `{dir, file, bytes}`。
4. 测试：GET 返回 tags；save 成功写入/覆盖（读回验证）；400 三分支（坏目录、`a/b.yaml` 与 `..`、非法 YAML）；带 tags 工作流 parse_yaml → WorkflowDef.tags。
5. 门禁：`cargo test -p flowscope-core`（53+新增）、`cargo fmt`、`cargo check -p flowscope-desktop`。

Commit: `feat(core): meta.tags 解析与文件夹保存端点（写回 git 文件夹）`

## T2 前端 + 文档

**Files:** `api/workflowModel.ts`、`api/client.ts`、`store/editorStore.ts`（updateModelMeta Pick 加 tags）、`components/PropertyPanel.tsx`（SettingsForm 标签输入）、`views/FolderWorkflows.tsx`、`views/WorkflowDetail.tsx`、`styles.css`、测试；`docs/superpowers/specs/2026-10-02-flowscope-current-state.md`、`docs/superpowers/CHANGELOG.md`、`README.md`。

1. **workflowModel**：`WorkflowModel.tags?: string[]`；parse：meta.tags 为字符串数组 → 收，非数组 → error（`meta.tags 必须是字符串数组`），缺省省略；serialize：有值时在 meta 下输出 `tags`（保持键序 name/version/tags）；roundtrip 测试（含空数组=省略）。
2. **editorStore**：`updateModelMeta` 的 Pick 增 `'tags'`（历史/脏语义同其它 meta 字段）。
3. **PropertyPanel SettingsForm**：标签输入（label「标签」，placeholder「逗号分隔，首个用于文件夹页分组」，失焦提交：按 `,` `，` 切分 trim 去空，空串→删除字段）。
4. **FolderWorkflows**：
   - 分组：`groupKey = f.tags[0] ?? '未分类'`；组名集合排序（未分类恒最后）；组内按 name.to_lowercase()；行显示全部 tags 徽标（小 pill）；
   - 组行：`▶/▾` 图标 + 组名 + 计数 + 整行可点切换；展开态记 localStorage key `fs-folder-collapsed`（值为收起组名数组，按 dir 记忆：`{[dir]: string[]}`——简单实现可全局一份收起集合+dir 重置，注明取舍）；
   - 「刷新」按钮（读取旁）：调 react-query refetch（同 dir）；读取成功后目录写 localStorage 逻辑不变；
   - 「在编辑器打开」navigate state 增 `originDir: res.dir, originFile: f.file`。
5. **client.ts**：`saveFolderWorkflow(body: {dir; file; yaml}): Promise<{dir; file; bytes}>`（POST）。
6. **WorkflowDetail**：location.state 有 originDir+originFile 时工具栏（保存旁）显示「保存到文件夹」按钮（fs-btn，title=目标路径）：点击 → 先 blur 冲刷（复用 Ctrl+S 的冲刷逻辑）→ `saveFolderWorkflow({dir: originDir, file: originFile, yaml: toYaml()})` → 成功 toast「已保存到 <originFile> ✓」+ invalidateQueries(['folder-workflows'])；失败显示错误。校验门与「保存」一致（problems 非空禁用）。**注意**：toYaml 含 tags（workflowModel 已保证）。
7. 测试：workflowModel tags roundtrip；SettingsForm 标签输入提交/清空；FolderWorkflows 分组排序（乱序 tags 数据断言组序与组内序、未分类最后）、展开收起切换、行 tag 徽标、刷新按钮触发 refetch、打开按钮 navigate state 含 origin；WorkflowDetail 无 origin 不显示按钮 / 有 origin 点击调 saveFolderWorkflow（mock）且 toast。
8. 门禁：`npm test -- --run && npm run typecheck && npm run build && npm run e2e`（120+新增，e2e 4/4——specs 不动）。
9. **文档同步**：现状文档 §2 API 表（save 端点 + tags 字段）、§5 文件夹页要点（分组/标记/保存路径/刷新）、§8 移除"导出回写文件夹"候选并注明已交付（保留"从文件夹直接运行"候选）；CHANGELOG 增条目；主 README 文件夹小节补三行（tags 用法、保存到文件夹、刷新）。

Commit: `feat(frontend): 文件夹页分类标记与分组收起、编辑器保存回文件夹、刷新（含文档同步）`

## 验收（控制台）

真实目录给两个测试文件加 tags（如 `tags: [演示]` 与不同 tag）→ 浏览器：文件夹页分组展示与展开收起 → 打开带 origin → 编辑器改 prompt → 「保存到文件夹」→ 磁盘文件已更新（tags 保留）→ 回文件夹页「刷新」见新内容。合入 main 推送。
