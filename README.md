# FlowScope

ACP（Agent Client Protocol）agent 工作流的可视化监控台：用 YAML 声明多节点工作流，
每个节点驱动一条真实 ACP agent 子进程会话，执行过程中的消息流、工具调用、Plan、
日志与节点产物被统一事件化（事件溯源），前端经 SSE 实时点亮 DAG 节点并支持逐节点
钻取查看。

## 界面预览

| 运行列表 | DAG 运行监控 | 节点抽屉（五 tab） |
|:---:|:---:|:---:|
| ![运行列表](docs/assets/run-list.png) | ![运行监控](docs/assets/run-monitor.png) | ![节点抽屉](docs/assets/node-drawer.png) |

深色可观测主题：状态色（蓝运行/绿完成/红失败/橙取消）在深底上高对比呈现，
DAG 画布为点阵网格底，运行中节点带脉冲光圈。全部颜色走 CSS 变量
（`frontend/src/styles.css` 的 `:root`），未来可低成本扩展浅色主题。

## 架构

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  前端 (React + ReactFlow)    │        │  企业 agent (任意 ACP v1 实现) │
│  运行列表 / DAG 监控 / 抽屉   │        │  例: Claude Code、自研 agent   │
└──────────────┬──────────────┘        └──────────────▲───────────────┘
               │ HTTP REST + SSE（同源）                │ JSON-RPC over stdio
               │                                        │ (spawn 子进程)
┌──────────────▼──────────────────────────────────────┴───────────────┐
│                    flowscope-core（内嵌 axum 服务）                   │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌─────────────────────┐  │
│  │ REST API │  │ SSE 事件流 │  │ 工作流引擎 │  │ ACP 层（会话/注册表） │  │
│  └────┬─────┘  └─────┬─────┘  └────┬─────┘  └─────────┬───────────┘  │
│       └──────┬───────┴──────┬──────┴──────────────────┘              │
│         ┌────▼──────────────▼─────┐                                 │
│         │ SQLite 事件溯源 + 产物     │   ← 每条会话更新/状态迁移都落库    │
│         └─────────────────────────┘                                 │
└──────────────────────────────────────────────────────────────────────┘
               ▲
               │ 进程内组装（共用 bootstrap）
┌──────────────┴──────────────┐
│ 宿主：dev 启动器（独立进程）    │
│ 或 Tauri 2 桌面壳（随机端口）  │
└─────────────────────────────┘
```

- **flowscope-core**：工作流 DSL 解析与调度引擎、ACP 子进程会话层、axum REST+SSE
  API、SQLite 事件溯源存储。dev 启动器（`bin/dev.rs`）与 Tauri 桌面壳共用
  `bootstrap()` 组装入口。
- **flowscope-mock-agent**：脚本驱动的 ACP v1 wire 级 mock（另支持崩溃注入），
  用于开发、演示与测试。
- **frontend**：React SPA（运行列表、工作流 YAML 编辑 + DAG 预览、运行监控
  ReactFlow 实时 DAG + 节点抽屉五 tab），由后端静态托管，同源直连。
- **apps/desktop**：Tauri 2 壳，进程内嵌引擎，窗口直连本地回环。

## 快速开始

前置：Rust（stable）、Node.js 20+ 与 npm。

```bash
# 1) 构建 mock agent（演示/冒烟测试需要）
cargo build -p flowscope-mock-agent

# 2) 构建前端
cd frontend
npm install
npm run build
cd ..

# 3) 启动开发服务器（首次启动会自动种子两个示例工作流：
#    weekly-report：3 节点全链路演示；crash-demo：进程崩溃失败注入）
cargo run -p flowscope-core --bin dev -- --port 39271 --home target/dev-home \
  --frontend-dist frontend/dist --mock-agent-bin target/debug/flowscope-mock-agent.exe
```

打开 <http://127.0.0.1:39271>，进入「工作流」→ 点开 `weekly-report` → 「启动运行」，
即可在监控页看到节点依次点亮与抽屉内容。

桌面版（Tauri 壳，进程内嵌引擎）：

```bash
cargo run -p flowscope-desktop
```

## 注册企业 agent

agent 以 `agents.toml` 注册（位于 home 目录，dev 启动器默认 `target/dev-home/`，
桌面版为系统数据目录；文件缺失且提供了 `--mock-agent-bin` 时会自动生成 mock 示例）。
每个条目声明 spawn 命令与可选的 cwd / env：

```toml
[agents.enterprise]
command = ["node", "enterprise-agent.js", "--acp"]   # spawn 命令（ACP v1 over stdio）
cwd = "D:/agents/enterprise"
env = { API_KEY_FILE = "secrets/api.key" }            # 值仅支持文件引用/明文，永不入库
name = "企业 Agent"
```

完整字段与握手语义（`initialize` 后读取 agent 声明的 `protocolVersion`、
`authMethods`、`modes` 等）见设计文档 §3.1：
`docs/superpowers/specs/2026-09-22-flowscope-design.md`。

## 测试矩阵

| 层 | 命令 | 覆盖 |
|---|---|---|
| Rust 单元/集成 | `cargo test` | DSL 解析/校验、引擎调度与重试、ACP 会话层（含子进程 wire 级）、事件/存储/SSE、脱敏纯函数 `events::redact()`、mock-agent 脚本机 |
| 前端单元 | `cd frontend && npm test` | 事件 reducer、图解析/布局、NodeCard/NodeDrawer 组件 |
| E2E 冒烟 | `cd frontend && npm run e2e` | Playwright 拉起 dev bin：mock 工作流全链路（3 节点点亮 + 抽屉消息/工具 + 终态 finished）与崩溃注入（节点红 + run failed） |

E2E 首次运行需先 `npx playwright install chromium`（webServer 会自动构建
mock-agent 并在 39271 端口起 dev bin）。

## M1 范围与 M2 展望

M1（当前）交付：core / mock-agent / 桌面壳三件套、ACP v1 会话层、工作流 DSL 与
调度引擎（条件边、重试、参数渲染）、SQLite 事件溯源 + SSE、四个核心视图
（运行列表 / 工作流列表 / 详情编辑 / 运行监控）。

- 设计文档：`docs/superpowers/specs/2026-09-22-flowscope-design.md`
- 实施计划：`docs/superpowers/plans/2026-09-22-flowscope-m1.md`

M2 候选方向（详见上述文档）：渲染后 prompt 回显、真实 agent 健康探活、桌面安装包
与 CSP 收紧、`session/load` 会话复用、脱敏规则接线、更完整的工作流 DSL 子集。

## 已知限制（M1）

- **渲染后 prompt 不回显**：SSE/REST 均不回传节点渲染后的输入 prompt，抽屉
  「输入输出」tab 的输入侧为 M2 占位（后端缺口已在任务记录中登记）。
- **前端 YAML 图解析器较脆弱**：编辑器 DAG 预览采用逐行扫描的简化解析，对非常规
  YAML 排版可能显示空图（原文编辑与后端解析不受影响）。
- **agent 无健康探测**：`GET /api/agents` 恒报 `healthy: true`。
- **桌面版未出安装包**：`bundle.active = false`，CSP 未配置，图标为占位；
  cargo-tauri CLI 未纳入本仓流程。
- **脱敏未接线**：spec §8 的脱敏能力 M1 已交付
  `flowscope_core::events::redact()` 纯函数（含单测）；config 规则加载与
  事件管道中的应用为 M2。
- **单用户本地工具**：无鉴权 / 多租户 / 权限模型。
- **取消语义局限**：仅支持本进程内 run 取消；进程重启后遗留 run 被标记
  `interrupted`，再取消返回 404。
