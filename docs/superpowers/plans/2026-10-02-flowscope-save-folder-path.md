# 编辑器「保存到文件夹」路径设置（通用化）

> 单一前端提交 + 文档同步；评审、浏览器验收、合入推送。分支 feature/save-folder-path（自 main 69fd462）。

**需求**：任何工作流（不限于从文件夹打开的）都能把画布内容保存到指定文件夹。「保存到文件夹」按钮常驻；无 origin → 弹对话框选目录+文件名；有 origin → 一键写回（现行为），另加「另存…」小按钮可改路径。保存成功后把所选路径记为该工作流的 origin（后续一键直达）。

## 实现要点（frontend/src/views/WorkflowDetail.tsx + styles.css + 测试 + 文档）

1. **origin 状态可写化**：origin 由 location.state 初始化（现状），新增本地 state `savedOrigin: {dir, file} | null`；`effectiveOrigin = savedOrigin ?? locationStateOrigin`；`hasOrigin = effectiveOrigin 存在`。「保存到文件夹」按钮从 `hasOrigin && isNew` 放宽为**常驻**（isNew 或已保存 DB 工作流都显示；仍受同一校验门禁）。
2. **点击行为**：`effectiveOrigin` 存在 → 现有直存流程（不变，成功 toast）；不存在 → 打开「保存到文件夹」对话框。
3. **对话框** `fs-folderdlg`（居中小卡）：label「目录路径」input（预填：localStorage `fs-workflow-dir`（文件夹页同键）→ 无则挂载时静默 `listFolderWorkflows()` 取后端默认 `res.dir`——复用 client，失败留空）+ label「文件名」input（预填 `model.name` 合法化：trim，空则 `workflow`；若不以 .yaml/.yml 结尾自动补 `.yaml`）+ 取消/保存。保存：客户端预校验（目录非空、文件名非空且无 `/` `\`——后端仍兜底）→ blur 冲刷 → `saveFolderWorkflow({dir, file, yaml: toYaml()})` → 成功：`setSavedOrigin({dir, file})` + toast「已保存到 <file> ✓」+ invalidate 文件夹键 + 关对话框；失败对话框内显示错误。
4. **「另存…」小按钮**：有 effectiveOrigin 时，「保存到文件夹」旁小号 ghost 按钮（title「更改保存路径/另存」）→ 打开同一对话框，预填 currentOrigin 的 dir/file；保存成功同样 setSavedOrigin。
5. 校验门（problems）、busy 态与两个保存按钮共用。

## 测试（WorkflowDetail.test.tsx 扩展）

- 无 origin 的 new 页：按钮存在；点击弹对话框且目录/文件名预填正确（mock localStorage 与 listFolderWorkflows）；填路径保存 → saveFolderWorkflow 参数正确（yaml 含画布内容）→ toast + 按钮变一键（再点不弹对话框，直接调 save）。
- 有 origin（location.state）：主按钮直存不弹对话框；「另存…」弹且预填 origin；改路径保存 → savedOrigin 更新（后续直存用新路径）。
- 文件名自动补 .yaml、非法名（含 /）预校验报错不发请求。

## 门禁与文档

- `npm test -- --run && npm run typecheck && npm run build && npm run e2e`（141+新增，e2e 4/4 specs 不动）。
- 现状文档 §5 编辑器行补「保存到文件夹常驻+路径设置对话框/另存」；CHANGELOG 条目；README 文件夹小节补一句。

Commit: `feat(frontend): 保存到文件夹通用化——路径设置对话框与另存（含文档同步）`
