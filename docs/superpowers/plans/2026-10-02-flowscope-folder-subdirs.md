# FlowScope 文件夹子目录归档（递归扫描）

> For agentic workers: 两个实现提交（T1 后端递归 / T2 前端分组+文档），一个实现者顺序完成；随后评审、浏览器验收、合入推送。按归档约定同步现状文档与 CHANGELOG。

**分支** feature/folder-subdirs（自 main ef4c740）。需求：工作流文件夹支持**子文件夹归档**——每类节点可能关联多个工作流脚本，平铺过大；递归扫描子目录，列表按「子文件夹」分组展示，打开/派生/保存路径精确回写各自子目录。

## T1 后端：递归扫描

**Files:** `crates/flowscope-core/src/api.rs` + 测试。

1. `fs_workflows` 改为递归扫描：从根目录遍历（深度上限 **4**），收集所有 `.yaml/.yml`；**跳过**隐藏目录（`.` 开头，如 `.git`）与 `node_modules`/`target`/`dist`（硬编码黑名单）；符号链接目录不跟随。
2. `FsWfFile` 增 `rel_dir: String`：文件相对根目录的目录部分（`""`=根目录；子目录用 `/` 分隔，如 `归档/2026`）；其余字段不变（name/version/valid/error/yaml/tags 逻辑照旧，逐文件 parse）。
3. 排序：`rel_dir` 为 `""` 的根目录文件**排在最前**，其余按 rel_dir 字母序；同目录内按 name.to_lowercase()（保持既有键序逻辑，二级键 filename）。
4. 响应结构不变（files 数组加字段），前端按 rel_dir 分组渲染。
5. 测试：临时目录构造 `根/alpha.yaml`（name "Zeta"）、`根/子A/beta.yaml`（name "Alpha"）、`根/子A/深/charlie.yaml`（name "Mike"）、`根/.git/x.yaml`（应跳过）、`根/node_modules/y.yaml`（跳过）→ 断言：返回 3 个文件、顺序 Zeta(根) < Alpha(子A) < Mike(子A/深)（rel_dir 排序：根在前，子A 组内名称序——注意 name 排序 Alpha<Mike 但跨组按 rel_dir 优先）、rel_dir 值正确、.git/node_modules 未收录；深度超限目录（第 5 层）不收录。

Commit: `feat(core): 工作流文件夹递归扫描（子目录归档，rel_dir 分组字段）`

## T2 前端：按子文件夹分组 + 路径回写 + 文档

**Files:** `frontend/src/api/client.ts`（FolderWorkflow 增 relDir）、`views/FolderWorkflows.tsx`、`views/WorkflowDetail.tsx`（origin 语义核对——若已按 dir+file 回写则只需确认子目录 dir 传入完整路径）、测试、`docs/superpowers/specs/2026-10-02-flowscope-current-state.md`、`docs/superpowers/CHANGELOG.md`、`README.md`。

1. FolderWorkflows 分组改为**两级视图**：外层组 = rel_dir（`根目录` / `子A` / `子A/深`，根在前、子目录按字母序，沿用展开/收起与 localStorage 记忆——键从组名变为 dir+组名避免跨目录串）；组内沿用现有 tag 分组？——**落定：不再按 tag 嵌套分组**（两层嵌套过深），组内平铺按名称序，tag 保留为行上徽标（既有能力）。 tag 分组能力不删除——当 rel_dir 全为根目录（无子文件夹）时保持现状按 tag 分组；有子文件夹时切到 rel_dir 分组。此规则写入代码注释与 README。
2. 行「在编辑器打开」state：originDir = `resolvedDir + '\\' + relDir`（relDir 空则 resolvedDir；Windows 分隔符——用 Path 语义拼，前端直接字符串拼 `/` 亦可，后端 canonicalize 均接受，落定用 `/`）；originFile 不变。派生对话框目录预填同步用 originDir。
3. 测试：mock 数据含 relDir → 分组渲染断言（根/子组序、收起记忆键）；打开/派生的 originDir 断言含子目录；无 relDir 兼容（旧后端响应缺字段 → 视为根目录，容错）。
4. 门禁：`npm test -- --run && npm run typecheck && npm run build && npm run e2e`（e2e 4/4，specs 不动）。
5. 文档同步：现状文档 §5 文件夹页行（递归扫描/rel_dir 分组/深度与黑名单）、§2 GET 行；CHANGELOG 条目；README 文件夹小节补「子文件夹归档」说明。

Commit: `feat(frontend): 文件夹页子目录归档分组与路径回写（含文档同步）`

## 验收（控制台）

真实目录建两级子目录放工作流（含一个同名不同目录的文件）→ 浏览器：分组展示与展开收起 → 子目录文件「在编辑器打开」→「保存到文件夹」→ 验证写回**同一子目录**。合入 main 推送。
