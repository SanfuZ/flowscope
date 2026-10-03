> ⚠️ 本文档已归档：大部分条目已由 M2a/M2c 交付或收编至 specs/2026-10-02-flowscope-current-state.md §8（遗留待办）。仅作历史记录，勿按此执行。

# FlowScope M2 待办清单（终审分诊产出）

来源：2026-09-23 M1 全分支终审评审（SHIP-WITH-LIST，两项 MUST-FIX 已于 ad11cef 修复）。
用途：M2 实施计划编写时的输入；与 spec §M2 承诺项（服务器/Web/回放/瀑布图/画布编辑器/token）合并排序。

## 行为修复（首项优先）

1. **R8 偏差**：ACP `stopReason: cancelled` 目前映射为 ProcessExit→Retryable 被重试并终态 failed；spec §3.2 期望 node-cancelled、不重试。涉及 session.rs 映射与 engine 的 NodeFailure2 分类（或引入 Cancelled 变体）。
2. **节点级 interrupted 不可达**：无 NodeInterrupted 事件；interrupted run 的节点在 UI 上永远 running（脉冲不停）。服务重启标记 run.interrupted 时应同时终结节点投影。
3. **hub 广播乱序窗口**：并行分支下 fetch_add 后才 publish，环内 seq 6 可先于 5 到达；live 客户端经 `seq<=lastSeq` 丢弃后无法恢复（页面刷新可恢复，store 无损）。收敛方案：emit 内同步 publish，或 SSE live 路径对 seq 空洞触发断流重连（复用 Lagged 机制）。

## spec 承诺补齐（M2 范围）

4. `flowscope-server` 独立二进制 + bearer token + Web 静态托管打磨（spec §2.2/§8）。
5. 运行历史/回放视图（seq 滑杆）+ 瀑布时间线（spec §7.1 视图 2/3）。
6. **画布图形编辑器**（节点面板/拖拽连边/内联属性/条件边表单/撤销重做；YAML 双向，注释不保留）——用户已确认提为 M2 承诺。
7. `POST /agents/:key/probe` + unhealthy 跟踪 + start_run 拒绝不健康 agent（spec §6.1/§9）。
8. SQLite 写失败 → run `degraded` + UI 警告条（spec §9）。
9. rolling-file 日志（`~/.flowscope/logs/`，spec §9）；桌面已初始化 tracing，dev/server 亦需。
10. `sessions` 表落库；initialize 元数据（authMethods/modes）持久化（spec §3.1/§5.2）。
11. 事件 payload 预留 OTel 字位落地：`token_usage`/`model`（spec §5.1；ACP v1 无来源，等 v2 或代理层）。
12. 脱敏接线：config 规则加载 + 事件管道应用（redact 纯函数已交付于 events.rs，含 5 单测；热路径改预编译缓存）。
13. 并发上限可配（引擎现为固定 4）+ 重试退避按 spec 改指数。
14. 表单式节点属性编辑（M1 只交付 YAML 编辑器 + 只读画布）。
15. 工具 tab 增强：每工具耗时 + content/diff 渲染（payload 已有 content，UI 未用）。
16. 渲染后 prompt 进 node.started payload（T11 记录的可观测性缺口；IO tab 输入区现状为占位）。
17. SSE 初始回填分页（现 after 上限 1M 全量载入）。
18. EventHub RunChannel 淘汰（现 ~1MB/run 常驻）。
19. fs 回调 `spawn_blocking` 化；fs 白名单 None-cwd 改默认拒绝。
20. `gen/schemas` gitignore；mock 探测支持 release profile；cargo-tauri CLI 安装 + 三平台打包 CI。

## 已接受不修（M1 文档化限制，见 README 已知限制节）

- mock-agent 三处外观项；cond `" and "` 引号不感知（启动期快速失败）；WAL 运行时未直测；
  StopReason 竞胜窄窗事件丢失；节点双终态竞态（末位胜出）；drained_events 测试启发式；
  store 同步 Mutex 于 async；useNow 首秒陈旧自愈；保存→refetch 输入回滚窗等。
