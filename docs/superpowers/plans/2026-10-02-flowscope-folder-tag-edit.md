# 文件夹页行内标记编辑

> 单一前端提交 + 文档同步；评审、浏览器验收、合入推送。分支 feature/folder-tag-edit（自 main a7f52d1）。

**需求**：文件夹页每行加「标记」按钮，就地编辑该工作流的 tags；保存=只改 `meta.tags` 地回写文件（**保留注释与既有排版**——用 yaml 包的 `parseDocument` 文档手术，不走全量 serialize），随后刷新列表即时重新分组。回答"分类如何承载"：tags 在 YAML 文件内（meta.tags），随 git 走。

## 实现要点

- `frontend/src/api/workflowModel.ts` 新增导出 `setYamlTags(yaml: string, tags: string[]): string`：`parseDocument` → `doc.get('meta')`（无 meta 或非 map → throw Error('缺少 meta 段')）→ tags 空 → `meta.delete('tags')`，否则 `meta.set('tags', tags)`（保持键序：set 对已存在键原位更新，新键追加——可接受）→ `String(doc)`。**不整档重排**（yaml 文档手术保留注释/缩进/其余行）。
- `FolderWorkflows.tsx`：每行操作列加「标记」按钮（fs-btn ghost 小号，data-testid={`tag-edit-${f.file}`}）→ 行内弹出小面板（该行下方插入一行 popover，或固定于列表上方的轻量对话框——落定：行下内嵌面板 `fs-tagpop`：输入框（label「标记」，placeholder 逗号分隔说明）+ 取消/保存按钮；打开时初值=当前 tags join(', ')）。保存：逗号切分（复用 SettingsForm 约定 `,` `，` trim 去空）→ `setYamlTags(f.yaml, tags)` → `saveFolderWorkflow({dir: resolvedDir, file: f.file, yaml: 新文本})` → 成功后关面板 + 重新加载列表（复用刷新逻辑）+ 无 toast（列表变化即反馈）；失败（含 parse 校验 400）面板内显示错误。取消=关面板不动文件。同一时间只开一个面板（打开新行关闭旧行）。
- 解析失败文件（valid:false）：「标记」按钮禁用，title=「文件无法解析，请先在编辑器中修复」。
- 分组即时性：保存后重载即重算分组；新出现的组名默认展开（不在收起集合中）——现有行为天然满足，无需改动。

## 测试

- workflowModel：setYamlTags 三态（新增 tags 到无 tags 文档 / 原位更新已有 tags / 空数组删除键）+ **保留注释**（文档含 `# 注释` 行与块式节点，手术后注释仍在）+ 无 meta 抛错。
- FolderWorkflows：点「标记」出面板且初值正确；保存调用 saveFolderWorkflow 且 yaml 为手术结果（mock）；保存后列表重载（mock 再次调用 list）；取消不调用；invalid 行按钮禁用。

## 门禁与文档

- `npm test -- --run && npm run typecheck && npm run build && npm run e2e`（132+新增，e2e 4/4 specs 不动）。
- 现状文档 §5 文件夹页行补「行内标记编辑（保留注释回写）」；CHANGELOG 增条目；README 文件夹小节补一句。

Commit: `feat(frontend): 文件夹页行内标记编辑——tags 就地增删、保留注释回写（含文档同步）`
