# FlowScope 独立二进制分发（standalone binary）实施计划

> For agentic workers: 两个实现提交（T1 嵌入+令牌 / T2 server bin+release 构建+文档），一个实现者顺序完成；随后评审、控制台验收、合入推送。按归档约定同步现状文档与 CHANGELOG。

**分支** feature/standalone-binary（自 main 5d35724）。目标：**可独立发送的二进制**——
1. `flowscope-server.exe`：无头单文件服务器，**前端 UI 嵌入 exe**，目标机双击/命令行运行 → 打印访问地址（含随机 token）→ 浏览器即用；
2. `flowscope-desktop.exe`（release）：Tauri 桌面单文件，同样**嵌入 UI**（不再依赖磁盘 dist），目标机需 WebView2（Win10/11 一般自带）。
两者静态链接 CRT（crt-static）最大限度免依赖。这也完成 M2 承诺的「flowscope-server 分离 + token」。

## 全局约束

- 新增依赖仅 `rust-embed = "8"`（features: ["debug-embed"] 供 dev 调试；或 `include_dir = "0.7"`——实现者按 API 顺滑度二选一，嵌 `frontend/dist`）。
- `frontend/dist` 构建期必须存在：flowscope-core 加 `build.rs`——dist 缺失时创建占位 `index.html`（防编译失败；正常流程先 `npm run build`）。占位页文案「FlowScope UI 未构建：请先在 frontend 执行 npm run build」。
- 既有测试全绿（cargo 57 / vitest 158 / e2e 4/4）；e2e specs 不动。
- 桌面版行为变化最小化：main.rs dist 参数改传 None（用嵌入资源）；窗口逻辑不变。
- 文档同步：现状文档 §2/§5/§7/§8、CHANGELOG、README（发布小节）。

## T1：前端资源嵌入 + 访问令牌（core）

**Files:** `crates/flowscope-core/build.rs`（新）、`src/assets.rs`（新）、`src/api.rs`、`Cargo.toml` + 测试。

1. `build.rs`：检查 `../../frontend/dist/index.html`，缺失则建目录并写占位页（每次构建都校验；有则不动）。
2. `assets.rs`：`rust_embed::RustEmbed` 嵌 dist；导出 `serve_embedded(path) -> Option<(Vec<u8>, mime)>`（mime 按扩展名小表：html/css/js/svg/png/ico/json/wasm/woff2…；默认 application/octet-stream）；**路径安全**：拒绝含 `..` 的请求路径（rust-embed 键以 `/` 开头规范——按 rust-embed 文档处理）。
3. `router_with_static(state, dist)` 语义扩展：`dist=None` 时自动用嵌入资源兜底 `/`（SPA 回退到 index.html；`/assets/*` 精确匹配）。dev 场景不变（传 Some(dist) 优先磁盘——保留热更新迭代能力）。
4. **令牌中间件**：`AppState`/router 增 `token: Option<String>`；Some 时所有请求须 `Authorization: Bearer <t>` **或** `?token=<t>`（SSE EventSource 场景），否则 401 `{error:"unauthorized"}`。无 token → 完全透传（桌面模式零影响）。dev bin 不设 token。
5. 测试：嵌入资源可达（GET / 返回含 FlowScope 的 html、/assets js 存在、含 `..` 路径 404/拒绝）；无 token 透传回归；设 token 后无凭据 401、?token= 与 Bearer 均过、错误 token 401。
6. 门禁：cargo test（57+新增）、fmt、check desktop。

Commit: `feat(core): 前端资源嵌入与访问令牌中间件`

## T2：flowscope-server bin + release 构建 + 文档

**Files:** `crates/flowscope-core/src/bin/server.rs`（新，Cargo.toml 加 `[[bin]] name="flowscope-server"`）、`README.md`、现状文档、CHANGELOG。

1. `server.rs`：参数 `--port <n>`（默认 8080）/`--home <dir>`（默认 `~/.flowscope`）/`--token <t>`（缺省**自动生成随机 16 hex** 并打印）/`--workflow-dir <dir>`（设 FLOWSCOPE_WORKFLOW_DIR）。流程：bootstrap(home, mock_bin=exe 同目录探测 `flowscope-mock-agent.exe`，dist=None 用嵌入) → bind `0.0.0.0:port` → 打印本机所有 IPv4 的 `http://<ip>:<port>/?token=<t>`（多网卡逐行列出）+ 提示「令牌即访问凭据，可 Ctrl+C 停止」→ serve。tracing 初始化同 dev。
2. **CRT 静态链接**：仓库根加 `.cargo/config.toml`：`[build] rustflags = ["-C", "target-feature=+crt-static"]`（影响所有 crate 的 release 与 dev——dev 期 mock 子进程 spawn 等不受影响，需全量重编译一次；若 desktop 链接异常（crt-static 与部分 crate 冲突）→ 退化为仅对两个 bin 设置 `RUSTFLAGS` 构建脚本/文档说明，报告实际选择）。
3. **Release 构建 + 冒烟**：`npm run build` → `cargo build --release -p flowscope-core`（server）与 `-p flowscope-desktop`；把 `flowscope-server.exe` + `flowscope-mock-agent.exe` 拷到干净临时目录，**从该目录运行**（设 --port 39330），curl 验证：无 token 401、带 token 首页 200 含 FlowScope、/api/agents 200；桌面 exe 存在性检查（大小 >10MB）。真实分发路径（另一台机器）无法在本机验证——报告注明依赖（WebView2/VC-runtime 已静态化声明）。
4. 文档：现状文档 §2（token 行为）、§5（server bin）、§7 构建命令加 release 分发流程；§8 划掉已完成项（server 分离+token+嵌入）。CHANGELOG 条目。README 新「独立分发」小节：server 用法、desktop 双击说明（WebView2）、agents.toml 注册、ZCode 依赖提示（桥四件套 env）。
5. 门禁：全套测试 + e2e。

Commit: `feat: flowscope-server 独立服务器 bin 与 release 分发构建（嵌入 UI/随机令牌/静态 CRT）`

## 验收（控制台）

干净目录跑 server exe：401→token 访问→建工作流→跑 mock→浏览器开 `?token=` 用一遍；桌面 release exe 启动冒烟（GUI 不可视验证沿用 API 探活法：进程存活 + 端口 200）。合入 main 推送。

## 风险

- crt-static 与 tauri/wry 在 Windows 的兼容性（wry 官方支持 crt-static，但需实测；异常则 server/desktop 分开 flag）。
- rust-embed 的路径与 MIME 边界情况（哈希文件名带点——按最后一段扩展名判断）。
- 首次 release 编译时长（全量 opt 编译，可能 5-15 分钟，正常）。
