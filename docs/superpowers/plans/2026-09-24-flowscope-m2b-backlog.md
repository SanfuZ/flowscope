# FlowScope M2b 待办清单（M2a 终审产出）

来源：2026-09-24 M2a（画布编辑器）全分支终审（SHIP-WITH-LIST，零 MUST-FIX）。
前置：M2a 已交付画布编辑器（T1-T8，分支 feature/m2a-canvas-editor）。

## M2b 首批（终审按序排列）

1. **loadYaml 失败静默死胡同**：载入后端合法但前端拒绝的 YAML（如 params 含非标量值——M1 自由上传可能产生）时，页面只显示「未加载」，parseErrors 不渲染、YAML 浮层也是空白，用户无法自救。修：载入失败渲染 parseErrors 横幅 + 决策 params 透传策略（建议照 on_node_failure 先例做 passthrough）。
2. **no-op 编辑噪音**：未变更的失焦提交也推历史+置脏（id/名称/params 行）；条件边三件套补全后逐键提交（每字符一个撤销步）。修：值差守卫统一化。
3. **validate 未镜像整数/范围约束**：version: 1.5、负数/浮点 retry.max、timeout_ms 前端门放行、后端 400。修：镜像 u32/u64 约束。
4. **条件边 trio 清值后 raw 显示陈旧**（store when 保留，raw 文本框显示旧表达式）。
5. WorkflowList 空态文案仍是「粘贴 YAML」（画布已是主路径）。
6. 保存后画布重排+撤销历史清空（positions 不持久的设计后果，打磨项）。

## 原 M2 剩余承诺（与 M1 时的待办清单合并排序）

- 独立服务器 flowscope-server + bearer token + Web 部署形态（spec §2.2/§8）
- 运行历史/回放视图（seq 滑杆）+ 瀑布时间线（spec §7.1 视图 2/3）
- 渲染后 prompt 回显（node.started payload，T11-M1 记录的缺口）
- agent 健康探活（POST /agents/:key/probe + start_run 拒绝不健康）
- 桌面安装包（tauri bundle）+ CSP 收紧 + cargo-tauri CLI 进流程
- 脱敏接线（config 规则加载 + 管道应用；纯函数已交付）
- sessions 表落库、token_usage/model 字位、并发可配+指数退避、SSE 回填分页、EventHub 淘汰、fs 回调 spawn_blocking、gen/schemas gitignore
（详见 docs/superpowers/plans/2026-09-23-flowscope-m2-backlog.md，其中画布编辑器与表单编辑两项已由 M2a 完成）

## 已接受不修（M2a 文档化限制）

YAML 应用不可撤销（loadYaml 语义）；多原子 and 仅 raw 可表达（三件套编辑整体覆盖）；
Ctrl+Shift+Y 重做超集；窄视口缩放回退；边 id 含 `->` 的极端情形；addNode 空模型防御分支等。
