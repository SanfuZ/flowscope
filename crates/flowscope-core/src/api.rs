//! axum HTTP/SSE API 层（spec §6.1 子集）+ bootstrap 组装。
//!
//! - [`AppState`]：Engine/Store/EventHub/AgentRegistry 的共享句柄。
//! - [`router`] / [`router_with_static`]：`/api` 路由树（可选前端静态托管 + SPA 回退）。
//! - [`bootstrap`]：按 home 目录组装全部组件（建库、加载 agents.toml、标记遗留
//!   running run 为 interrupted），返回 `(AppState, Router)`——dev 启动器与
//!   Tauri 主进程（T15）共用这一入口。
//!
//! SSE（`GET /api/runs/{id}/events`）合并算法：先 `hub.subscribe` 再
//! `hub.snapshot_after`（环形缓冲），缺口用 `store.events_after` 补齐，按 seq
//! 去重排序后逐条下发；直播阶段只转发 seq 大于已发最大值的事件，broadcast
//! 溢出（Lagged）即断流，由浏览器 EventSource 携 Last-Event-ID 重连补缺口。

use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::{Path as AxPath, Query, State, rejection::JsonRejection};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response, sse};
use axum::routing::{get, post};
use futures::{Stream, StreamExt, stream};
use serde::Deserialize;
use serde_json::{Value, json};
use thiserror::Error;
use tokio::sync::broadcast;

use crate::acp::AgentRegistry;
use crate::acp::registry::PermissionDefault;
use crate::engine::{AcpExecutor, Engine, EngineError};
use crate::events::FsEvent;
use crate::hub::EventHub;
use crate::store::{RunRow, Store};
use crate::workflow::{self, WorkflowDef};

/// bootstrap 专用简单错误（按控制器裁定：不引入 anyhow）。
#[derive(Debug, Error)]
pub enum ApiError {
    #[error("{0}")]
    Msg(String),
}

/// API 层共享状态：全部字段皆 `Arc`，clone 廉价。
#[derive(Clone)]
pub struct AppState {
    pub engine: Arc<Engine>,
    pub store: Arc<Store>,
    pub hub: Arc<EventHub>,
    pub registry: Arc<AgentRegistry>,
}

/// `/api` 路由树（无静态托管）。
pub fn router(state: AppState) -> Router {
    router_with_static(state, None)
}

/// `/api` 路由树 + 可选前端静态托管：`dist` 为 `Some` 时在 `/` 挂
/// `ServeDir`，未命中文件回退 `index.html`（SPA history 路由）。
/// `/api` 显式路由优先于静态服务。
pub fn router_with_static(state: AppState, dist: Option<PathBuf>) -> Router {
    let api = Router::new()
        .route("/workflows", get(list_workflows).post(create_workflow))
        .route("/workflows/{id}", get(get_workflow).delete(delete_workflow))
        .route("/workflows/{id}/runs", post(start_run))
        .route("/runs", get(list_runs))
        .route("/runs/{id}", get(get_run))
        .route("/runs/{id}/cancel", post(cancel_run))
        .route("/runs/{id}/events", get(run_events))
        .route("/runs/{id}/artifacts/{node}/{name}", get(get_artifact))
        .route("/agents", get(list_agents))
        .with_state(state);
    let mut app = Router::new().nest("/api", api);
    if let Some(dist) = dist {
        // axum 0.8 不允许 nest_service("/")，用 fallback_service 承接全部未命中
        // 路由；ServeDir 未命中文件再回退 index.html（SPA history 路由，200）。
        // 注意用 fallback 而非 not_found_service：后者会强制把状态码改成 404。
        // `/api` 显式路由优先于 fallback。
        let spa = tower_http::services::ServeDir::new(&dist).fallback(
            tower_http::services::ServeFile::new(dist.join("index.html")),
        );
        app = app.fallback_service(spa);
    }
    app
}

/// 组装整个后端：建 home 目录、开 SQLite（home/flowscope.db）、EventHub、
/// AgentRegistry（读 home/agents.toml；缺失且给了 mock agent 时写默认配置
/// 并加载）、Engine（AcpExecutor）+ 标记遗留 running run 为 interrupted。
///
/// T15（Tauri main）与 `bin/dev.rs` 共用本入口；返回的 Router 已含静态托管。
pub async fn bootstrap(
    home: &Path,
    mock_agent_bin: Option<PathBuf>,
    dist: Option<PathBuf>,
) -> Result<(AppState, Router), ApiError> {
    std::fs::create_dir_all(home)
        .map_err(|e| ApiError::Msg(format!("创建 home 目录 {} 失败: {e}", home.display())))?;
    let store = Arc::new(
        Store::open(&home.join("flowscope.db"))
            .map_err(|e| ApiError::Msg(format!("打开 store 失败: {e}")))?,
    );
    let hub = Arc::new(EventHub::new());

    let agents_toml = home.join("agents.toml");
    let registry = if agents_toml.exists() {
        Arc::new(
            AgentRegistry::load_toml(&agents_toml)
                .map_err(|e| ApiError::Msg(format!("加载 agents.toml 失败: {e}")))?,
        )
    } else if let Some(bin) = mock_agent_bin.as_deref() {
        write_default_agents_toml(home, bin)?;
        Arc::new(
            AgentRegistry::load_toml(&agents_toml)
                .map_err(|e| ApiError::Msg(format!("加载生成的 agents.toml 失败: {e}")))?,
        )
    } else {
        Arc::new(AgentRegistry::default())
    };

    let engine = Arc::new(Engine::new(
        Arc::clone(&store),
        Arc::clone(&hub),
        Arc::new(AcpExecutor {
            registry: Arc::clone(&registry),
        }),
    ));
    engine.mark_interrupted_on_boot();

    let state = AppState {
        engine,
        store,
        hub,
        registry,
    };
    let router = router_with_static(state.clone(), dist);
    Ok((state, router))
}

/// 写默认 agents.toml（key `mock` → demo-script、key `bad-mock` → crash-script）
/// 及两份脚本到 home/scripts/。路径用 TOML 单引号字面串以容忍 Windows 反斜杠。
fn write_default_agents_toml(home: &Path, mock_bin: &Path) -> Result<(), ApiError> {
    let scripts_dir = home.join("scripts");
    std::fs::create_dir_all(&scripts_dir)
        .map_err(|e| ApiError::Msg(format!("创建 scripts 目录失败: {e}")))?;
    let demo = scripts_dir.join("demo-script.yaml");
    let crash = scripts_dir.join("crash-script.yaml");
    std::fs::write(&demo, DEMO_SCRIPT_YAML)
        .map_err(|e| ApiError::Msg(format!("写 demo 脚本失败: {e}")))?;
    std::fs::write(&crash, CRASH_SCRIPT_YAML)
        .map_err(|e| ApiError::Msg(format!("写 crash 脚本失败: {e}")))?;
    let content = format!(
        "# FlowScope 默认 agent 配置（bootstrap 生成；可手工编辑，重启生效）\n\
         [agents.mock]\n\
         command = ['{bin}', '--script', '{demo}']\n\
         name = 'Mock Agent (demo)'\n\
         permission_default = 'deny'\n\
         \n\
         [agents.bad-mock]\n\
         command = ['{bin}', '--script', '{crash}']\n\
         name = 'Mock Agent (crash)'\n\
         permission_default = 'deny'\n",
        bin = mock_bin.display(),
        demo = demo.display(),
        crash = crash.display(),
    );
    std::fs::write(home.join("agents.toml"), content)
        .map_err(|e| ApiError::Msg(format!("写 agents.toml 失败: {e}")))?;
    Ok(())
}

const DEMO_SCRIPT_YAML: &str = r#"# flowscope-mock-agent 演示脚本（bootstrap 生成）
steps:
  - {delay_ms: 50, message: "正在收集数据..."}
  - {tool: {id: t1, title: "查询数据库", kind: fetch, status: in_progress}}
  - {delay_ms: 80, message: "检索完成"}
  - {tool: {id: t1, status: completed, content: ["rows: 3"]}}
  - {plan: [{id: p1, content: 收集数据, status: completed}, {id: p2, content: 生成摘要, status: in_progress}]}
  - {message: '{"ok": true, "data_path": "out/report.md"}'}
final_message: '{"ok": true, "data_path": "out/report.md"}'
stop: end_turn
crash_after: null
stderr_lines: ["mock agent starting"]
"#;

const CRASH_SCRIPT_YAML: &str = r#"# flowscope-mock-agent 崩溃注入脚本（bootstrap 生成）
steps:
  - {delay_ms: 10, message: "about to crash"}
stop: end_turn
crash_after: 1
stderr_lines: ["mock agent starting"]
"#;

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

fn err_json(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "error": msg.into() }))).into_response()
}

fn store_err(e: crate::store::StoreError) -> Response {
    err_json(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

fn engine_status(e: &EngineError) -> StatusCode {
    match e {
        EngineError::InvalidWorkflow(_) | EngineError::ParamsNotObject(_) => {
            StatusCode::BAD_REQUEST
        }
        EngineError::UnknownRun(_) => StatusCode::NOT_FOUND,
        EngineError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn list_workflows(State(st): State<AppState>) -> Response {
    match st.store.list_workflows() {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => store_err(e),
    }
}

#[derive(Deserialize)]
struct CreateWorkflowBody {
    yaml: String,
}

async fn create_workflow(
    State(st): State<AppState>,
    body: Result<Json<CreateWorkflowBody>, JsonRejection>,
) -> Response {
    let Json(body) = match body {
        Ok(b) => b,
        Err(rej) => return err_json(StatusCode::BAD_REQUEST, rej.body_text()),
    };
    let wf = match workflow::parse_yaml(&body.yaml) {
        Ok(wf) => wf,
        Err(e) => return err_json(StatusCode::BAD_REQUEST, e.to_string()),
    };
    if let Err(e) = workflow::validate(&wf) {
        return err_json(StatusCode::BAD_REQUEST, e.to_string());
    }
    match st.store.upsert_workflow(&wf.name, wf.version, &body.yaml) {
        Ok(id) => Json(json!({ "id": id })).into_response(),
        Err(e) => store_err(e),
    }
}

async fn get_workflow(State(st): State<AppState>, AxPath(id): AxPath<String>) -> Response {
    match st.store.get_workflow(&id) {
        Ok(Some(row)) => Json(row).into_response(),
        Ok(None) => err_json(StatusCode::NOT_FOUND, format!("workflow {id} 不存在")),
        Err(e) => store_err(e),
    }
}

async fn delete_workflow(State(st): State<AppState>, AxPath(id): AxPath<String>) -> Response {
    match st.store.delete_workflow(&id) {
        Ok(true) => (StatusCode::NO_CONTENT, "").into_response(),
        Ok(false) => err_json(StatusCode::NOT_FOUND, format!("workflow {id} 不存在")),
        Err(e) => store_err(e),
    }
}

#[derive(Deserialize, Default)]
struct StartRunBody {
    params: Option<Value>,
}

async fn start_run(
    State(st): State<AppState>,
    AxPath(id): AxPath<String>,
    body: String,
) -> Response {
    // 空 body 视为无参数覆盖；非空则必须是 {"params": {...}} 形态
    let params = if body.trim().is_empty() {
        Value::Null
    } else {
        match serde_json::from_str::<StartRunBody>(&body) {
            Ok(b) => b.params.unwrap_or(Value::Null),
            Err(e) => return err_json(StatusCode::BAD_REQUEST, format!("请求体不合法: {e}")),
        }
    };

    let row = match st.store.get_workflow(&id) {
        Ok(Some(row)) => row,
        Ok(None) => return err_json(StatusCode::NOT_FOUND, format!("workflow {id} 不存在")),
        Err(e) => return store_err(e),
    };
    let def: WorkflowDef = match workflow::parse_yaml(&row.yaml) {
        Ok(def) => def,
        Err(e) => {
            return err_json(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("存量 workflow YAML 已不可解析: {e}"),
            );
        }
    };

    match st.engine.start_run(def.clone(), params).await {
        Ok(run_id) => {
            // engine.start_run 会在 (name,version) 上以 JSON 快照顶掉 YAML 原文
            // （为满足 runs 外键）；此处写回原文，保证 GET /workflows/{id} 稳定。
            if let Err(e) = st.store.upsert_workflow(&def.name, def.version, &row.yaml) {
                tracing::warn!(error = %e, "恢复 workflow YAML 原文失败");
            }
            Json(json!({ "run_id": run_id })).into_response()
        }
        Err(e) => err_json(engine_status(&e), e.to_string()),
    }
}

async fn list_runs(
    State(st): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let wf = q.get("workflow_id").cloned();
    let status = q.get("status").cloned();
    match st.store.list_runs() {
        Ok(rows) => Json(
            rows.into_iter()
                .filter(|r| {
                    wf.as_deref().map_or(true, |w| r.workflow_id == w)
                        && status.as_deref().map_or(true, |s| r.status == s)
                })
                .collect::<Vec<RunRow>>(),
        )
        .into_response(),
        Err(e) => store_err(e),
    }
}

async fn get_run(State(st): State<AppState>, AxPath(id): AxPath<String>) -> Response {
    match st.store.get_run(&id) {
        Ok(Some(row)) => Json(row).into_response(),
        Ok(None) => err_json(StatusCode::NOT_FOUND, format!("run {id} 不存在")),
        Err(e) => store_err(e),
    }
}

async fn cancel_run(State(st): State<AppState>, AxPath(id): AxPath<String>) -> Response {
    match st.engine.cancel_run(&id) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => err_json(engine_status(&e), e.to_string()),
    }
}

async fn get_artifact(
    State(st): State<AppState>,
    AxPath((run_id, node_id, name)): AxPath<(String, String, String)>,
) -> Response {
    match st.store.get_artifact_with_type(&run_id, &node_id, &name) {
        Ok(Some((content_type, content))) => {
            ([(header::CONTENT_TYPE, content_type)], content).into_response()
        }
        Ok(None) => err_json(
            StatusCode::NOT_FOUND,
            format!("artifact {node_id}/{name} 在 run {run_id} 中不存在"),
        ),
        Err(e) => store_err(e),
    }
}

async fn list_agents(State(st): State<AppState>) -> Response {
    let agents: Vec<Value> = st
        .registry
        .agents
        .values()
        .map(|cfg| {
            json!({
                "key": cfg.key,
                "name": cfg.name,
                "permission_default": match cfg.permission_default {
                    PermissionDefault::AllowOnce => "allow_once",
                    PermissionDefault::Deny => "deny",
                },
                // M1 不做健康探测，恒报 healthy=true；M2 引入真实探活
                "healthy": true,
            })
        })
        .collect();
    Json(agents).into_response()
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

fn sse_frame(ev: &FsEvent) -> sse::Event {
    sse::Event::default()
        .id(ev.seq.to_string())
        .event("fs")
        .data(serde_json::to_string(ev).unwrap_or_else(|_| "{}".into()))
}

/// 直播阶段：只转发 seq 严格大于已发最大值的事件（重复/迟到丢弃）。
/// broadcast 溢出（Lagged）说明慢客户端已永久错过事件——此时**结束流**
/// （而非跳过继续）：浏览器 EventSource 会自动重连并携带 Last-Event-ID，
/// 走本 handler 既有的 ring + store 回放补齐缺口。通道关闭则流自然结束。
fn live_events(
    rx: broadcast::Receiver<Arc<FsEvent>>,
    after: u64,
) -> impl Stream<Item = Result<sse::Event, Infallible>> {
    stream::unfold((rx, after), |(mut rx, mut max)| async move {
        loop {
            match rx.recv().await {
                Ok(ev) if ev.seq > max => {
                    max = ev.seq;
                    return Some((Ok(sse_frame(&ev)), (rx, max)));
                }
                Ok(_) => continue,
                Err(broadcast::error::RecvError::Lagged(missed)) => {
                    tracing::warn!(
                        missed,
                        "SSE 直播溢出，结束流——客户端将以 Last-Event-ID 重连补缺口"
                    );
                    return None;
                }
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    })
}

async fn run_events(
    State(st): State<AppState>,
    AxPath(run_id): AxPath<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    match st.store.get_run(&run_id) {
        Ok(Some(_)) => {}
        Ok(None) => return err_json(StatusCode::NOT_FOUND, format!("run {run_id} 不存在")),
        Err(e) => return store_err(e),
    }
    // after 优先级：query 参数 > Last-Event-ID 头 > 0
    let after = match q.get("after").map(|s| s.parse::<u64>()) {
        Some(Ok(n)) => n,
        Some(Err(_)) => {
            return err_json(StatusCode::BAD_REQUEST, "after 必须是 u64");
        }
        None => headers
            .get("last-event-id")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse().ok())
            .unwrap_or(0),
    };

    // 先订阅后快照：订阅之后 publish 的事件只会出现在 rx，不会双发漏发
    let rx = st.hub.subscribe(&run_id);
    let ring = st.hub.snapshot_after(&run_id, after);
    let mut seen: HashSet<u64> = ring.iter().map(|e| e.seq).collect();
    let mut initial: Vec<FsEvent> = ring.iter().map(|e| (**e).clone()).collect();
    // ring 之外的早期事件（容量 4096 逐出）从 store 补
    match st.store.events_after(&run_id, after, 1_000_000) {
        Ok(persisted) => {
            for ev in persisted {
                if seen.insert(ev.seq) {
                    initial.push(ev);
                }
            }
        }
        Err(e) => tracing::warn!(error = %e, run_id = %run_id, "SSE 回放读 store 失败，仅用 ring"),
    }
    initial.sort_unstable_by_key(|e| e.seq);
    let sent_max = initial.last().map(|e| e.seq).unwrap_or(after).max(after);

    let replay = stream::iter(
        initial
            .into_iter()
            .map(|ev| Ok::<sse::Event, Infallible>(sse_frame(&ev))),
    );
    let body = sse::Sse::new(replay.chain(live_events(rx, sent_max)))
        .keep_alive(sse::KeepAlive::new().interval(Duration::from_secs(15)));
    body.into_response()
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{EventSink, ExecRequest, NodeExecutor, NodeFailure2};
    use crate::events::EventKind;
    use async_trait::async_trait;
    use axum::body::Body;
    use axum::http::Request;
    use futures::StreamExt;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    /// 即时完成的执行器：API 测试不依赖真实 agent 进程。
    struct InstantExecutor;

    #[async_trait]
    impl NodeExecutor for InstantExecutor {
        async fn execute(
            &self,
            _req: ExecRequest,
            _sink: &EventSink,
        ) -> Result<String, NodeFailure2> {
            Ok("{\"ok\": true, \"note\": \"instant\"}".into())
        }
    }

    fn test_state() -> AppState {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let hub = Arc::new(EventHub::new());
        let engine = Arc::new(Engine::new(
            Arc::clone(&store),
            Arc::clone(&hub),
            Arc::new(InstantExecutor),
        ));
        AppState {
            engine,
            store,
            hub,
            registry: Arc::new(AgentRegistry::default()),
        }
    }

    async fn body_string(res: Response) -> String {
        let bytes = BodyExt::collect(res.into_body()).await.unwrap().to_bytes();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    /// oneshot 请求 → (状态码, JSON)；空 body 或非 JSON 回 Null/原串。
    async fn req_json(app: &Router, req: Request<Body>) -> (StatusCode, Value) {
        let res = app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let text = body_string(res).await;
        let parsed = serde_json::from_str(&text).unwrap_or_else(|_| Value::String(text.clone()));
        (status, parsed)
    }

    fn post_json(uri: String, body: Value) -> Request<Body> {
        Request::post(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn get_req(uri: String) -> Request<Body> {
        Request::get(uri).body(Body::empty()).unwrap()
    }

    const WF_YAML: &str =
        "meta: {name: demo-wf, version: 1}\nnodes:\n  - {id: solo, agent: m, prompt: p}\n";

    #[tokio::test]
    async fn workflows_crud_roundtrip() {
        let app = router(test_state());

        // POST 合法 → 200 {id}
        let (status, body) = req_json(
            &app,
            post_json("/api/workflows".into(), json!({"yaml": WF_YAML})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let id = body["id"].as_str().unwrap().to_owned();

        // GET 列表含该工作流
        let (status, body) = req_json(&app, get_req("/api/workflows".into())).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            body.as_array()
                .unwrap()
                .iter()
                .any(|w| w["id"] == id.as_str() && w["name"] == "demo-wf" && w["version"] == 1),
            "list: {body}"
        );

        // GET 单个回 YAML 原文
        let (status, body) = req_json(&app, get_req(format!("/api/workflows/{id}"))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["yaml"].as_str().unwrap(), WF_YAML);
        assert_eq!(body["name"].as_str().unwrap(), "demo-wf");

        // POST 结构非法（环）→ 400 {error}
        let cyclic = "meta: {name: cyc, version: 1}\nnodes:\n  - {id: a, agent: m, prompt: p}\n  \
                      - {id: b, agent: m, prompt: p}\nedges:\n  - {from: a, to: b}\n  - {from: b, to: a}\n";
        let (status, body) = req_json(
            &app,
            post_json("/api/workflows".into(), json!({"yaml": cyclic})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(body["error"].as_str().is_some());

        // POST YAML 语法错误 → 400
        let (status, body) = req_json(
            &app,
            post_json("/api/workflows".into(), json!({"yaml": "meta: [broken"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

        // POST 缺 yaml 字段 → 400
        let (status, _) =
            req_json(&app, post_json("/api/workflows".into(), json!({"nope": 1}))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        // DELETE → 204，随后 GET/再 DELETE → 404
        let res = app
            .clone()
            .oneshot(
                Request::delete(format!("/api/workflows/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        let (status, _) = req_json(&app, get_req(format!("/api/workflows/{id}"))).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let res = app
            .clone()
            .oneshot(
                Request::delete(format!("/api/workflows/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn start_run_lifecycle_filters_and_artifact() {
        let state = test_state();
        let app = router(state.clone());

        let (status, body) = req_json(
            &app,
            post_json("/api/workflows".into(), json!({"yaml": WF_YAML})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let id = body["id"].as_str().unwrap().to_owned();

        // POST runs → 200 {run_id}
        let (status, body) = req_json(
            &app,
            post_json(
                format!("/api/workflows/{id}/runs"),
                json!({"params": {"x": 1}}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let run_id = body["run_id"].as_str().unwrap().to_owned();

        // 轮询 GET run 至终态
        let mut row = None;
        for _ in 0..500 {
            let (status, body) = req_json(&app, get_req(format!("/api/runs/{run_id}"))).await;
            assert_eq!(status, StatusCode::OK);
            if body["status"] == "finished" {
                row = Some(body);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let row = row.expect("run 5s 内未到终态");
        assert_eq!(row["workflow_id"], id.as_str());
        assert_eq!(row["params"]["x"], 1);

        // 过滤：workflow_id + status 命中，status=running 不命中
        let (status, body) = req_json(
            &app,
            get_req(format!("/api/runs?workflow_id={id}&status=finished")),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            body.as_array()
                .unwrap()
                .iter()
                .any(|r| r["id"] == run_id.as_str())
        );
        let (_, body) = req_json(&app, get_req("/api/runs?status=running".into())).await;
        assert!(
            !body
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["id"] == run_id.as_str())
        );

        // run 启动后 workflow YAML 原文被恢复（未被引擎 JSON 快照顶掉）
        let (status, body) = req_json(&app, get_req(format!("/api/workflows/{id}"))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["yaml"].as_str().unwrap(), WF_YAML);

        // artifact：引擎为每个完成节点写 output（application/json）
        let res = app
            .clone()
            .oneshot(get_req(format!("/api/runs/{run_id}/artifacts/solo/output")))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(
            res.headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|ct| ct.starts_with("application/json"))
        );
        let text = body_string(res).await;
        assert!(text.contains("ok"), "artifact: {text}");

        // 未知 run → 404（详情 / cancel / events / artifact）
        let (status, _) = req_json(&app, get_req("/api/runs/run_zzz".into())).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = req_json(
            &app,
            post_json("/api/runs/run_zzz/cancel".into(), json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = req_json(&app, get_req("/api/runs/run_zzz/events?after=0".into())).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = req_json(&app, get_req("/api/runs/run_zzz/artifacts/n/x".into())).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // 未知 workflow 启动 run → 404
        let (status, _) = req_json(
            &app,
            post_json(
                "/api/workflows/wf_missing/runs".to_owned(),
                json!({"params": {}}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    /// 起 run 直到终态 finished（直接走 engine，绕过 HTTP）。
    async fn start_finished_run(state: &AppState) -> String {
        let wf = workflow::parse_yaml(WF_YAML).unwrap();
        let run_id = state.engine.start_run(wf, json!({})).await.unwrap();
        for _ in 0..500 {
            if let Some(row) = state.store.get_run(&run_id).unwrap() {
                if row.status == "finished" {
                    return run_id;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("run {run_id} 5s 内未 finished");
    }

    #[derive(Debug)]
    struct Frame {
        id: Option<u64>,
        event: Option<String>,
        data: Option<String>,
    }

    fn parse_frames(text: &str) -> Vec<Frame> {
        text.split("\n\n")
            .filter(|f| !f.trim().is_empty())
            .map(|f| {
                let mut fr = Frame {
                    id: None,
                    event: None,
                    data: None,
                };
                for line in f.lines() {
                    if let Some(v) = line.strip_prefix("id: ") {
                        fr.id = v.trim().parse().ok();
                    } else if let Some(v) = line.strip_prefix("event: ") {
                        fr.event = Some(v.trim().to_owned());
                    } else if let Some(v) = line.strip_prefix("data: ") {
                        fr.data = Some(v.trim().to_owned());
                    }
                }
                fr
            })
            .collect()
    }

    /// 读 SSE body 流直到谓词满足或超时（秒），返回累计文本。
    async fn read_sse_until(res: Response, pred: impl Fn(&str) -> bool, timeout_s: u64) -> String {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_s);
        let mut stream = res.into_body().into_data_stream();
        let mut text = String::new();
        while let Some(chunk) = tokio::time::timeout_at(deadline, stream.next())
            .await
            .unwrap_or(None)
        {
            if let Ok(bytes) = chunk {
                text.push_str(&String::from_utf8_lossy(&bytes));
                if pred(&text) {
                    return text;
                }
            }
        }
        text
    }

    #[tokio::test]
    async fn sse_replays_events_with_ascending_seq() {
        let state = test_state();
        let app = router(state.clone());
        let run_id = start_finished_run(&state).await;

        let res = app
            .clone()
            .oneshot(get_req(format!("/api/runs/{run_id}/events?after=0")))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(
            res.headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|ct| ct.starts_with("text/event-stream"))
        );
        let text = read_sse_until(res, |t| t.contains("run.finished"), 10).await;
        let frames = parse_frames(&text);
        let ids: Vec<u64> = frames.iter().filter_map(|f| f.id).collect();
        assert_eq!(ids.first(), Some(&1), "回放必须从 seq 1 开始: {text}");
        assert!(
            ids.windows(2).all(|w| w[0] < w[1]),
            "seq 必须严格递增: {ids:?}"
        );
        assert!(frames.len() >= 4, "至少 started/节点×2/finished: {text}");
        for f in &frames {
            assert_eq!(f.event.as_deref(), Some("fs"), "帧: {f:?}");
            let data: Value =
                serde_json::from_str(f.data.as_deref().expect("每帧必有 data")).unwrap();
            assert_eq!(data["seq"].as_u64(), f.id, "data.seq 与 id 字段一致");
            assert!(data["kind"].as_str().is_some());
        }
        assert!(
            frames
                .iter()
                .any(|f| f.data.as_deref().unwrap_or("").contains("run.finished"))
        );
    }

    #[tokio::test]
    async fn sse_after_skips_replay_and_streams_live_events() {
        let state = test_state();
        let app = router(state.clone());
        let run_id = start_finished_run(&state).await;

        // after=1：跳过 seq 1，首帧 id=2
        let res = app
            .clone()
            .oneshot(get_req(format!("/api/runs/{run_id}/events?after=1")))
            .await
            .unwrap();
        let text = read_sse_until(res, |t| t.contains("run.finished"), 10).await;
        let ids: Vec<u64> = parse_frames(&text).iter().filter_map(|f| f.id).collect();
        assert_eq!(ids.first(), Some(&2), "after=1 后首帧应为 seq 2: {text}");
        assert!(!ids.contains(&1));

        // after=最大 seq：初始为空；流打开后再 publish → 直播到达
        let max_seq = *ids.last().unwrap();
        let res = app
            .clone()
            .oneshot(get_req(format!(
                "/api/runs/{run_id}/events?after={max_seq}"
            )))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        // oneshot 已完成 handler（含 hub.subscribe），此后发布的事件只会走 rx
        state.hub.publish(FsEvent {
            seq: max_seq + 1,
            ts: chrono::Utc::now(),
            run_id: run_id.clone(),
            node_id: None,
            session_id: None,
            kind: EventKind::LogLines,
            payload: json!({"lines": ["live-payload"], "source": "stderr"}),
        });
        let text = read_sse_until(res, |t| t.contains("live-payload"), 10).await;
        let frames = parse_frames(&text);
        assert!(
            frames.iter().any(|f| f.id == Some(max_seq + 1)
                && f.data
                    .as_deref()
                    .is_some_and(|d| d.contains("live-payload"))),
            "直播事件未到达: {text}"
        );
    }

    #[tokio::test]
    async fn sse_last_event_id_header_equivalent() {
        let state = test_state();
        let app = router(state.clone());
        let run_id = start_finished_run(&state).await;

        // 只带 Last-Event-ID: 2（无 query）→ 等价 after=2，首帧 id=3
        let res = app
            .clone()
            .oneshot(
                Request::get(format!("/api/runs/{run_id}/events"))
                    .header("last-event-id", "2")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let text = read_sse_until(res, |t| t.contains("run.finished"), 10).await;
        let ids: Vec<u64> = parse_frames(&text).iter().filter_map(|f| f.id).collect();
        assert_eq!(
            ids.first(),
            Some(&3),
            "Last-Event-ID=2 后首帧应为 seq 3: {text}"
        );

        // 非法 after → 400
        let (status, _) =
            req_json(&app, get_req(format!("/api/runs/{run_id}/events?after=x"))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    /// Lagged（慢客户端溢出 broadcast 容量 1024）必须**结束流**而不是静默
    /// 跳过 seq 继续直播：结束后浏览器 EventSource 自动重连带 Last-Event-ID，
    /// 由既有 ring+store 回放补齐缺口。若实现退回 `continue`，本测试会在
    /// 有界等待内收不到流结束而失败。
    #[tokio::test]
    async fn sse_lagged_receiver_terminates_stream_for_reconnect() {
        let state = test_state();
        let app = router(state.clone());
        let run_id = start_finished_run(&state).await;

        // 打开流：oneshot 完成 = handler 已 subscribe + 快照（回放仅含本次
        // run 的少量事件），此后 rx 上未消费任何消息
        let res = app
            .clone()
            .oneshot(get_req(format!("/api/runs/{run_id}/events?after=0")))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        // 不读流的情况下灌 1200 条（> 容量 1024）→ 首次 recv 必然 Lagged
        const FILL: u64 = 1200;
        for i in 0..FILL {
            state.hub.publish(FsEvent {
                seq: 100_000 + i,
                ts: chrono::Utc::now(),
                run_id: run_id.clone(),
                node_id: None,
                session_id: None,
                kind: EventKind::LogLines,
                payload: json!({"lines": ["lag-fill"], "source": "stderr"}),
            });
        }

        // 有界等待（10s，小于 15s keep-alive 间隔）内流必须结束（None），
        // 且不得出现跳seq后转发的 lag-fill 帧
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let mut stream = res.into_body().into_data_stream();
        let mut text = String::new();
        let mut ended = false;
        loop {
            match tokio::time::timeout_at(deadline, stream.next()).await {
                Ok(Some(Ok(bytes))) => text.push_str(&String::from_utf8_lossy(&bytes)),
                Ok(Some(Err(_))) => {}
                Ok(None) => {
                    ended = true;
                    break;
                }
                Err(_) => break, // 超时未结束
            }
        }
        assert!(
            ended,
            "Lagged 后流应在 10s 内结束以便 EventSource 重连补缺口，实际挂起: {text}"
        );
        assert!(
            !text.contains("lag-fill"),
            "Lagged 后不得跳过 seq 静默转发新事件: {text}"
        );
        assert!(
            text.contains("run.finished"),
            "回放部分不受影响（含 run.finished）: {text}"
        );
    }

    #[tokio::test]
    async fn bootstrap_seeds_home_and_default_agents() {
        let home =
            std::env::temp_dir().join(format!("flowscope-bs-{}", uuid::Uuid::new_v4().simple()));

        // 1) 无 mock bin：空 registry，路由可用
        let (state, app) = bootstrap(&home, None, None).await.unwrap();
        assert!(state.store.list_workflows().unwrap().is_empty());
        assert!(home.join("flowscope.db").exists());
        let (status, body) = req_json(&app, get_req("/api/agents".into())).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.as_array().unwrap().len(), 0);

        // 2) 给 mock bin（bootstrap 只写配置不执行，路径无需真实存在）
        let (_state, app) = bootstrap(
            &home,
            Some(PathBuf::from("C:/nowhere/mock-agent.exe")),
            None,
        )
        .await
        .unwrap();
        assert!(home.join("agents.toml").exists());
        assert!(home.join("scripts").join("demo-script.yaml").exists());
        assert!(home.join("scripts").join("crash-script.yaml").exists());
        let (status, body) = req_json(&app, get_req("/api/agents".into())).await;
        assert_eq!(status, StatusCode::OK);
        let arr = body.as_array().unwrap();
        assert_eq!(arr.len(), 2, "mock + bad-mock: {body}");
        assert!(arr.iter().any(|a| a["key"] == "mock"));
        assert!(arr.iter().any(|a| a["key"] == "bad-mock"));
        assert!(arr.iter().all(|a| a["healthy"] == true));

        // 3) 再次 bootstrap：加载已存在的 agents.toml，不重复生成
        let (state, app) = bootstrap(&home, None, None).await.unwrap();
        let (_, body) = req_json(&app, get_req("/api/agents".into())).await;
        assert_eq!(body.as_array().unwrap().len(), 2, "复用既有 agents.toml");
        assert_eq!(state.registry.agents.len(), 2);

        let _ = std::fs::remove_dir_all(&home);
    }

    /// 静态托管：dist 存在时 `/` 走 ServeDir、未命中回退 index.html（SPA）、
    /// `/api` 路由不受影响。（回归：axum 0.8 禁止 nest_service("/")，
    /// 旧写法在运行时 panic。）
    #[tokio::test]
    async fn static_dist_serves_files_and_spa_fallback() {
        let dist =
            std::env::temp_dir().join(format!("flowscope-dist-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("index.html"), "<!doctype html>SPA").unwrap();
        std::fs::write(dist.join("app.js"), "console.log(1)").unwrap();
        let app = router_with_static(test_state(), Some(dist.clone()));

        // 静态文件
        let res = app.clone().oneshot(get_req("/".into())).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(body_string(res).await.contains("SPA"));
        let res = app
            .clone()
            .oneshot(get_req("/app.js".into()))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        // SPA history 路由回退 index.html
        let res = app
            .clone()
            .oneshot(get_req("/runs/whatever/detail".into()))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(body_string(res).await.contains("SPA"));

        // API 路由仍优先
        let (status, body) = req_json(&app, get_req("/api/agents".into())).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.as_array().unwrap().len(), 0);

        let _ = std::fs::remove_dir_all(&dist);
    }
}
