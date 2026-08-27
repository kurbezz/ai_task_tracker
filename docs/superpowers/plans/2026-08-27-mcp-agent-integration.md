# MCP Agent Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed an MCP (Model Context Protocol) server in the existing Rust/Axum backend so AI agents can self-report task progress (create tasks, move status, add logs, set tags, update agent/result) as native MCP tool calls, authenticated the same way as the REST API.

**Architecture:** A new `backend/src/mcp.rs` module defines `TaskMcpServer`, an `rmcp` `#[tool_router]` type holding a `SqlitePool`. It is mounted at `/mcp` via `rmcp`'s `StreamableHttpService`, nested into the existing Axum router and wrapped with the same `auth::require_api_key` middleware used for `/api`. Each REST handler in `handlers/tasks.rs` and `handlers/projects.rs` is refactored to delegate to a `..._core` function that both the HTTP handler and the matching MCP tool call, so validation and transition rules live in exactly one place.

**Tech Stack:** Rust, Axum 0.7 (unchanged), `rmcp` (official Rust MCP SDK) with `server` + `transport-streamable-http-server` features, `schemars` for JSON-schema-derived tool parameters, sqlx/SQLite (unchanged).

**Spec:** `docs/superpowers/specs/2026-08-27-mcp-agent-integration-design.md`

---

## File structure

```
backend/
  Cargo.toml                    Add rmcp + schemars deps (main + dev)
  src/
    lib.rs                      Mount /mcp alongside /api, reuse auth middleware
    mcp.rs                      NEW: TaskMcpServer + tool definitions
    handlers/
      tasks.rs                  Extract *_core functions reused by MCP tools
      projects.rs                Extract list_projects_core
  tests/
    support/mod.rs              Add spawn_http_server + mcp_client_transport helpers
    mcp.rs                      NEW: end-to-end MCP integration tests
README.md                       Add MCP section
```

---

### Task 1: Wire up the MCP transport with a smoke-test tool

**Files:**
- Modify: `backend/Cargo.toml`
- Create: `backend/src/mcp.rs`
- Modify: `backend/src/lib.rs:1-13,20-68`
- Modify: `backend/tests/support/mod.rs`
- Create: `backend/tests/mcp.rs`

This task proves the whole plumbing (dependency, mounting, auth reuse, real MCP client round-trip) works before any real tool touches the database.

- [ ] **Step 1: Add the rmcp and schemars dependencies**

Run:
```bash
cargo add rmcp --manifest-path backend/Cargo.toml --features server,transport-streamable-http-server
cargo add schemars --manifest-path backend/Cargo.toml
cargo add rmcp --manifest-path backend/Cargo.toml --dev --features client,transport-streamable-http-client-reqwest --rename rmcp-client
```

The third command will fail because `cargo add` cannot add the same crate twice under different names for the same package easily via `--rename` combined with an existing entry — instead, add the dev-dependency by hand. Skip the third command above and instead open `backend/Cargo.toml` and add this block after `[dev-dependencies]`:

```toml
[dev-dependencies]
tower = { version = "0.5", features = ["util"] }
http-body-util = "0.1"
rmcp = { version = "*", features = ["client", "transport-streamable-http-client-reqwest"] }
```

Replace the `version = "*"` on that new line with whatever exact version `cargo add rmcp ...` (the first command above) wrote into `[dependencies]`, so both entries resolve to the identical version.

Expected: `backend/Cargo.toml` has `rmcp` (with `server, transport-streamable-http-server` features) and `schemars` under `[dependencies]`, and a second `rmcp` entry (with `client, transport-streamable-http-client-reqwest` features) under `[dev-dependencies]`.

- [ ] **Step 2: Write the failing MCP smoke test**

Create `backend/tests/mcp.rs`:

```rust
mod support;

use rmcp::{
    model::{CallToolRequestParams, ClientInfo},
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
    },
    ServiceExt,
};

#[tokio::test]
async fn ping_tool_round_trips_over_authenticated_mcp_session() {
    let (base_url, server) = support::spawn_http_server(support::state().await).await;

    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(format!("{base_url}/mcp"))
            .custom_headers(support::api_key_header()),
    );
    let client = ClientInfo::default()
        .serve(transport)
        .await
        .expect("authenticated client should connect");

    let tools = client.list_tools(Default::default()).await.expect("list tools");
    assert!(tools.tools.iter().any(|tool| tool.name == "ping"));

    let result = client
        .call_tool(
            CallToolRequestParams::new("ping")
                .with_arguments(serde_json::json!({}).as_object().cloned().unwrap()),
        )
        .await
        .expect("ping call should succeed");
    assert_ne!(result.is_error, Some(true));

    client.cancel().await.expect("cancel client");
    server.abort();
}

#[tokio::test]
async fn mcp_route_rejects_missing_api_key() {
    let (base_url, server) = support::spawn_http_server(support::state().await).await;

    let response = reqwest::Client::new()
        .post(format!("{base_url}/mcp"))
        .header("content-type", "application/json")
        .body(r#"{"jsonrpc":"2.0","method":"initialize","params":{},"id":1}"#)
        .send()
        .await
        .expect("request should complete");

    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    server.abort();
}
```

The second test needs a raw `reqwest` client, not the rmcp one, so also add `reqwest` as a dev-dependency:

```bash
cargo add reqwest --manifest-path backend/Cargo.toml --dev --no-default-features --features rustls-tls,json
```

- [ ] **Step 3: Add the test server + auth header helpers**

Modify `backend/tests/support/mod.rs`. Add these imports to the top of the file (alongside the existing ones):

```rust
use std::collections::HashMap;
use std::net::SocketAddr;
```

Append these functions at the end of the file:

```rust
#[allow(dead_code)]
pub async fn spawn_http_server(state: AppState) -> (String, tokio::task::JoinHandle<()>) {
    let router = ai_task_tracker::build_router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test listener should bind");
    let addr: SocketAddr = listener.local_addr().expect("listener address");
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    (format!("http://{addr}"), handle)
}

#[allow(dead_code)]
pub fn api_key_header() -> HashMap<http::HeaderName, http::HeaderValue> {
    let mut headers = HashMap::new();
    headers.insert(
        http::HeaderName::from_static("x-api-key"),
        http::HeaderValue::from_static("test-key"),
    );
    headers
}
```

`http` is already a dependency of the `ai_task_tracker` crate (see `backend/Cargo.toml`); add it as a dev-dependency too so `backend/tests/support/mod.rs` can use it directly:

```bash
cargo add http --manifest-path backend/Cargo.toml --dev
```

- [ ] **Step 4: Run the new tests and confirm they fail to compile**

Run: `cargo test --manifest-path backend/Cargo.toml --test mcp`

Expected: compile error — `ai_task_tracker::mcp` module does not exist yet.

- [ ] **Step 5: Create the MCP server module with one smoke-test tool**

Create `backend/src/mcp.rs`:

```rust
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, ContentBlock, ServerCapabilities, ServerInfo},
    schemars, tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler,
};
use sqlx::SqlitePool;

use crate::AppState;

#[derive(Clone)]
pub struct TaskMcpServer {
    pool: SqlitePool,
    tool_router: ToolRouter<TaskMcpServer>,
}

impl TaskMcpServer {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            pool,
            tool_router: Self::tool_router(),
        }
    }

    fn state(&self) -> AppState {
        AppState {
            pool: self.pool.clone(),
        }
    }
}

#[tool_router]
impl TaskMcpServer {
    #[tool(description = "Health check for the AI Task Tracker MCP server")]
    async fn ping(&self) -> Result<CallToolResult, McpError> {
        Ok(CallToolResult::success(vec![ContentBlock::text("pong")]))
    }
}

#[tool_handler]
impl ServerHandler for TaskMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(
            "Tools for AI agents to self-report progress on AI Task Tracker tasks."
                .to_string(),
        )
    }
}
```

(`Parameters` and `schemars` are imported now even though unused by `ping` — Task 2 uses them immediately. If `cargo build` warns about the unused import before Task 2 lands, that is expected and fine; it will stop being unused in the next task.)

- [ ] **Step 6: Mount the MCP route in the router**

Modify `backend/src/lib.rs`. Replace the whole file with:

```rust
use axum::{
    http::StatusCode,
    middleware,
    routing::{delete, get, post},
    Router,
};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};

pub mod auth;
pub mod db;
pub mod error;
pub mod handlers;
pub mod mcp;
pub mod models;
pub mod static_files;

#[derive(Clone)]
pub struct AppState {
    pub pool: sqlx::SqlitePool,
}

pub fn build_router(state: AppState) -> Router {
    let api = Router::new()
        .route(
            "/projects",
            get(handlers::projects::list_projects).post(handlers::projects::create_project),
        )
        .route(
            "/projects/:id",
            get(handlers::projects::get_project)
                .patch(handlers::projects::update_project)
                .delete(handlers::projects::delete_project),
        )
        .route("/tasks", post(handlers::tasks::create_task))
        .route(
            "/tasks/:id",
            get(handlers::tasks::get_task).patch(handlers::tasks::update_task),
        )
        .route(
            "/projects/:id/tasks",
            get(handlers::tasks::list_project_tasks),
        )
        .route("/tasks/:id/status", post(handlers::tasks::transition_task))
        .route(
            "/tasks/:id/logs",
            get(handlers::tasks::list_logs).post(handlers::tasks::create_log),
        )
        .route("/tasks/:id/tags", post(handlers::tasks::attach_tag))
        .route(
            "/tasks/:id/tags/:tag_id",
            delete(handlers::tasks::remove_tag),
        )
        .route("/tags", get(handlers::tags::list_tags))
        .route(
            "/tasks/needs-attention",
            get(handlers::tasks::list_attention),
        )
        .fallback(|| async { StatusCode::NOT_FOUND })
        .layer(middleware::from_fn(error::normalize_api_errors))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_api_key,
        ));

    let mcp_pool = state.pool.clone();
    let mcp_service = StreamableHttpService::new(
        move || Ok(mcp::TaskMcpServer::new(mcp_pool.clone())),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default(),
    );
    let mcp: Router<AppState> = Router::new()
        .nest_service("/mcp", mcp_service)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_api_key,
        ));

    Router::new()
        .route("/health", get(|| async { "ok" }))
        .nest("/api", api)
        .merge(mcp)
        .fallback(static_files::serve)
        .with_state(state)
}
```

If `cargo build` reports a state-type mismatch on `.merge(mcp)`, it means `mcp`'s state type was inferred as `()` instead of `AppState`; the `let mcp: Router<AppState> = ...` annotation above should prevent that, but if it still happens, add `::<AppState>` to the `Router::new()` call on the `mcp` binding: `Router::<AppState>::new()`.

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `cargo test --manifest-path backend/Cargo.toml --test mcp`

Expected: both `ping_tool_round_trips_over_authenticated_mcp_session` and `mcp_route_rejects_missing_api_key` pass.

- [ ] **Step 8: Run the full suite and formatter**

Run: `cargo fmt --manifest-path backend/Cargo.toml --check && cargo test --manifest-path backend/Cargo.toml`

Expected: formatter succeeds, every existing test still passes (no regression from the `lib.rs` rewrite), plus the two new MCP tests.

- [ ] **Step 9: Commit**

```bash
git add backend
git commit -m "feat: mount MCP server with smoke-test ping tool"
```

---

### Task 2: `create_task` and `get_task` MCP tools

**Files:**
- Modify: `backend/src/handlers/tasks.rs:19-59,61-68`
- Modify: `backend/src/models.rs:99-105`
- Modify: `backend/src/mcp.rs`
- Modify: `backend/tests/mcp.rs`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/mcp.rs`:

```rust
async fn create_project(base_url: &str) -> String {
    let response = reqwest::Client::new()
        .post(format!("{base_url}/api/projects"))
        .header("x-api-key", "test-key")
        .json(&serde_json::json!({"name": "Tracker"}))
        .send()
        .await
        .expect("create project request should complete");
    let body: serde_json::Value = response.json().await.expect("json body");
    body["id"].as_str().expect("project id").to_owned()
}

#[tokio::test]
async fn create_task_and_get_task_tools_round_trip() {
    let (base_url, server) = support::spawn_http_server(support::state().await).await;
    let project_id = create_project(&base_url).await;

    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(format!("{base_url}/mcp"))
            .custom_headers(support::api_key_header()),
    );
    let client = ClientInfo::default().serve(transport).await.expect("client connects");

    let create_args: serde_json::Map<String, serde_json::Value> = serde_json::from_value(
        serde_json::json!({ "project_id": project_id, "title": "Ship the MCP server" }),
    )
    .unwrap();
    let created = client
        .call_tool(CallToolRequestParams::new("create_task").with_arguments(create_args))
        .await
        .expect("create_task should succeed");
    assert_ne!(created.is_error, Some(true));
    let created_text = created.content.first().expect("content block");
    let created_task: serde_json::Value =
        serde_json::from_str(created_text.as_text().expect("text content").text.as_str())
            .expect("valid task json");
    assert_eq!(created_task["title"], "Ship the MCP server");
    assert_eq!(created_task["status"], "TODO");
    let task_id = created_task["id"].as_str().expect("task id").to_owned();

    let get_args: serde_json::Map<String, serde_json::Value> =
        serde_json::from_value(serde_json::json!({ "task_id": task_id })).unwrap();
    let fetched = client
        .call_tool(CallToolRequestParams::new("get_task").with_arguments(get_args))
        .await
        .expect("get_task should succeed");
    assert_ne!(fetched.is_error, Some(true));

    client.cancel().await.expect("cancel client");
    server.abort();
}
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cargo test --manifest-path backend/Cargo.toml --test mcp create_task_and_get_task_tools_round_trip`

Expected: failure — `create_task` / `get_task` are not registered tools yet (rmcp returns a tool-not-found error, surfaced as a call error or panic on `.expect`).

- [ ] **Step 3: Extract `create_task_core` in the REST handler**

Modify `backend/src/handlers/tasks.rs`. Replace the current `create_task` function (lines 19-59) with:

```rust
pub async fn create_task(
    State(state): State<AppState>,
    Json(input): Json<CreateTask>,
) -> Result<impl IntoResponse, AppError> {
    Ok((
        StatusCode::CREATED,
        Json(create_task_core(&state, input).await?),
    ))
}

pub(crate) async fn create_task_core(
    state: &AppState,
    input: CreateTask,
) -> Result<TaskResponse, AppError> {
    ensure_project(state, &input.project_id).await?;
    validate_title(&input.title)?;

    let now = Utc::now().to_rfc3339();
    let task = Task {
        id: Uuid::new_v4().to_string(),
        project_id: input.project_id,
        title: input.title,
        description: input.description,
        status: Status::Todo.to_string(),
        agent: input.agent,
        result_summary: None,
        created_at: now.clone(),
        updated_at: now,
    };
    sqlx::query(
        "INSERT INTO tasks (id, project_id, title, description, status, agent, result_summary, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&task.id)
    .bind(&task.project_id)
    .bind(&task.title)
    .bind(&task.description)
    .bind(&task.status)
    .bind(&task.agent)
    .bind(&task.result_summary)
    .bind(&task.created_at)
    .bind(&task.updated_at)
    .execute(&state.pool)
    .await
    .map_err(AppError::Internal)?;

    task_response(state, task).await
}
```

`get_task` (lines 61-68) already delegates to `fetch_task` + `task_response`, both already `pub(crate)` — no change needed there.

- [ ] **Step 4: Make `CreateTask` MCP-schema-derivable**

Modify `backend/src/models.rs`. Change the `CreateTask` struct (lines 99-105) from:

```rust
#[derive(Deserialize)]
pub struct CreateTask {
```

to:

```rust
#[derive(Deserialize, schemars::JsonSchema)]
pub struct CreateTask {
```

- [ ] **Step 5: Add the `create_task` and `get_task` MCP tools**

Modify `backend/src/mcp.rs`. Add these imports at the top, alongside the existing `use` lines:

```rust
use crate::{
    error::AppError,
    handlers::tasks,
    models::CreateTask,
};
```

Add a `to_mcp_error` helper and a `json_result` helper near the top of the file (below the imports, above `TaskMcpServer`):

```rust
fn to_mcp_error(error: AppError) -> McpError {
    match error {
        AppError::NotFound => McpError::invalid_params("not found", None),
        AppError::Validation(message) => McpError::invalid_params(message, None),
        AppError::InvalidTransition(message) => McpError::invalid_params(message, None),
        AppError::Internal(db_error) => {
            eprintln!("internal database error: {db_error}");
            McpError::internal_error("internal server error", None)
        }
        AppError::Unauthorized
        | AppError::MethodNotAllowed
        | AppError::BadRequest(_)
        | AppError::UnprocessableEntity(_)
        | AppError::PayloadTooLarge
        | AppError::UnsupportedMediaType => McpError::internal_error("unexpected error", None),
    }
}

fn json_result<T: serde::Serialize>(value: &T) -> Result<CallToolResult, McpError> {
    let text = serde_json::to_string(value)
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;
    Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
}
```

Add these tool methods inside the existing `#[tool_router] impl TaskMcpServer { ... }` block, after `ping`:

```rust
#[tool(description = "Create a new task in a project. New tasks start in TODO status.")]
async fn create_task(
    &self,
    Parameters(input): Parameters<CreateTask>,
) -> Result<CallToolResult, McpError> {
    let state = self.state();
    let response = tasks::create_task_core(&state, input)
        .await
        .map_err(to_mcp_error)?;
    json_result(&response)
}

#[tool(description = "Get a task by id, including its current status and tags")]
async fn get_task(
    &self,
    Parameters(GetTaskParams { task_id }): Parameters<GetTaskParams>,
) -> Result<CallToolResult, McpError> {
    let state = self.state();
    let task = tasks::fetch_task(&state, &task_id)
        .await
        .map_err(to_mcp_error)?;
    let response = tasks::task_response(&state, task)
        .await
        .map_err(to_mcp_error)?;
    json_result(&response)
}
```

Add the `GetTaskParams` struct anywhere above `TaskMcpServer` (e.g. right after the `json_result` helper):

```rust
#[derive(serde::Deserialize, schemars::JsonSchema)]
struct GetTaskParams {
    task_id: String,
}
```

- [ ] **Step 6: Run the tests**

Run: `cargo test --manifest-path backend/Cargo.toml --test mcp create_task_and_get_task_tools_round_trip`

Expected: PASS.

- [ ] **Step 7: Run the full suite and formatter**

Run: `cargo fmt --manifest-path backend/Cargo.toml --check && cargo test --manifest-path backend/Cargo.toml`

Expected: all tests pass, including the existing `tests/tasks.rs` suite (proves the `create_task` refactor did not change REST behavior).

- [ ] **Step 8: Commit**

```bash
git add backend
git commit -m "feat: add create_task and get_task MCP tools"
```

---

### Task 3: `list_projects` and `list_project_tasks` MCP tools

**Files:**
- Modify: `backend/src/handlers/projects.rs:16-25`
- Modify: `backend/src/handlers/tasks.rs:100-119`
- Modify: `backend/src/mcp.rs`
- Modify: `backend/tests/mcp.rs`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/mcp.rs`:

```rust
#[tokio::test]
async fn list_projects_and_list_project_tasks_tools_return_created_data() {
    let (base_url, server) = support::spawn_http_server(support::state().await).await;
    let project_id = create_project(&base_url).await;

    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(format!("{base_url}/mcp"))
            .custom_headers(support::api_key_header()),
    );
    let client = ClientInfo::default().serve(transport).await.expect("client connects");

    let list_projects_result = client
        .call_tool(
            CallToolRequestParams::new("list_projects")
                .with_arguments(serde_json::json!({}).as_object().cloned().unwrap()),
        )
        .await
        .expect("list_projects should succeed");
    let projects_text = list_projects_result.content.first().expect("content block");
    let projects: serde_json::Value =
        serde_json::from_str(projects_text.as_text().expect("text content").text.as_str())
            .expect("valid projects json");
    assert!(projects.as_array().unwrap().iter().any(|p| p["id"] == project_id));

    let create_args: serde_json::Map<String, serde_json::Value> = serde_json::from_value(
        serde_json::json!({ "project_id": project_id, "title": "Task in project" }),
    )
    .unwrap();
    client
        .call_tool(CallToolRequestParams::new("create_task").with_arguments(create_args))
        .await
        .expect("create_task should succeed");

    let list_tasks_args: serde_json::Map<String, serde_json::Value> =
        serde_json::from_value(serde_json::json!({ "project_id": project_id })).unwrap();
    let list_tasks_result = client
        .call_tool(CallToolRequestParams::new("list_project_tasks").with_arguments(list_tasks_args))
        .await
        .expect("list_project_tasks should succeed");
    let tasks_text = list_tasks_result.content.first().expect("content block");
    let tasks: serde_json::Value =
        serde_json::from_str(tasks_text.as_text().expect("text content").text.as_str())
            .expect("valid tasks json");
    assert_eq!(tasks.as_array().unwrap().len(), 1);
    assert_eq!(tasks[0]["title"], "Task in project");

    client.cancel().await.expect("cancel client");
    server.abort();
}
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cargo test --manifest-path backend/Cargo.toml --test mcp list_projects_and_list_project_tasks_tools_return_created_data`

Expected: failure — `list_projects` / `list_project_tasks` tools not registered.

- [ ] **Step 3: Extract `list_projects_core`**

Modify `backend/src/handlers/projects.rs`. Replace `list_projects` (lines 16-25) with:

```rust
pub async fn list_projects(State(state): State<AppState>) -> Result<Json<Vec<Project>>, AppError> {
    Ok(Json(list_projects_core(&state).await?))
}

pub(crate) async fn list_projects_core(state: &AppState) -> Result<Vec<Project>, AppError> {
    let projects = sqlx::query_as::<_, Project>(
        "SELECT id, name, description, created_at FROM projects ORDER BY created_at",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(AppError::Internal)?;

    Ok(projects)
}
```

- [ ] **Step 4: Extract `list_project_tasks_core`**

Modify `backend/src/handlers/tasks.rs`. Replace `list_project_tasks` (lines 100-119) with:

```rust
pub async fn list_project_tasks(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<Vec<TaskResponse>>, AppError> {
    Ok(Json(list_project_tasks_core(&state, &project_id).await?))
}

pub(crate) async fn list_project_tasks_core(
    state: &AppState,
    project_id: &str,
) -> Result<Vec<TaskResponse>, AppError> {
    ensure_project(state, project_id).await?;
    let tasks = sqlx::query_as::<_, Task>(
        "SELECT id, project_id, title, description, status, agent, result_summary, created_at, updated_at \
         FROM tasks WHERE project_id = ? ORDER BY created_at",
    )
    .bind(project_id)
    .fetch_all(&state.pool)
    .await
    .map_err(AppError::Internal)?;

    let mut responses = Vec::with_capacity(tasks.len());
    for task in tasks {
        responses.push(task_response(state, task).await?);
    }
    Ok(responses)
}
```

- [ ] **Step 5: Add the MCP tools**

Modify `backend/src/mcp.rs`. Update the `use crate::{...}` block to also import `handlers::projects`:

```rust
use crate::{
    error::AppError,
    handlers::{projects, tasks},
    models::CreateTask,
};
```

Add these tool methods inside `#[tool_router] impl TaskMcpServer { ... }`, after `get_task`:

```rust
#[tool(description = "List all projects")]
async fn list_projects(&self) -> Result<CallToolResult, McpError> {
    let state = self.state();
    let response = projects::list_projects_core(&state)
        .await
        .map_err(to_mcp_error)?;
    json_result(&response)
}

#[tool(description = "List all tasks in a project")]
async fn list_project_tasks(
    &self,
    Parameters(ListProjectTasksParams { project_id }): Parameters<ListProjectTasksParams>,
) -> Result<CallToolResult, McpError> {
    let state = self.state();
    let response = tasks::list_project_tasks_core(&state, &project_id)
        .await
        .map_err(to_mcp_error)?;
    json_result(&response)
}
```

Add the params struct next to `GetTaskParams`:

```rust
#[derive(serde::Deserialize, schemars::JsonSchema)]
struct ListProjectTasksParams {
    project_id: String,
}
```

- [ ] **Step 6: Run the tests**

Run: `cargo test --manifest-path backend/Cargo.toml --test mcp list_projects_and_list_project_tasks_tools_return_created_data`

Expected: PASS.

- [ ] **Step 7: Run the full suite and formatter**

Run: `cargo fmt --manifest-path backend/Cargo.toml --check && cargo test --manifest-path backend/Cargo.toml`

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add backend
git commit -m "feat: add list_projects and list_project_tasks MCP tools"
```

---

### Task 4: `transition_task_status` MCP tool

**Files:**
- Modify: `backend/src/handlers/tasks.rs:121-202`
- Modify: `backend/src/models.rs` (add `schemars::JsonSchema` to `Status`)
- Modify: `backend/src/mcp.rs`
- Modify: `backend/tests/mcp.rs`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/mcp.rs`:

```rust
#[tokio::test]
async fn transition_task_status_tool_enforces_workflow_rules() {
    let (base_url, server) = support::spawn_http_server(support::state().await).await;
    let project_id = create_project(&base_url).await;

    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(format!("{base_url}/mcp"))
            .custom_headers(support::api_key_header()),
    );
    let client = ClientInfo::default().serve(transport).await.expect("client connects");

    let create_args: serde_json::Map<String, serde_json::Value> = serde_json::from_value(
        serde_json::json!({ "project_id": project_id, "title": "Transition me" }),
    )
    .unwrap();
    let created = client
        .call_tool(CallToolRequestParams::new("create_task").with_arguments(create_args))
        .await
        .expect("create_task should succeed");
    let created_task: serde_json::Value = serde_json::from_str(
        created.content.first().unwrap().as_text().unwrap().text.as_str(),
    )
    .unwrap();
    let task_id = created_task["id"].as_str().unwrap().to_owned();

    let valid_args: serde_json::Map<String, serde_json::Value> = serde_json::from_value(
        serde_json::json!({ "task_id": task_id, "status": "IN_PLANNING" }),
    )
    .unwrap();
    let valid = client
        .call_tool(CallToolRequestParams::new("transition_task_status").with_arguments(valid_args))
        .await
        .expect("valid transition call should return a result");
    assert_ne!(valid.is_error, Some(true));
    let transitioned: serde_json::Value = serde_json::from_str(
        valid.content.first().unwrap().as_text().unwrap().text.as_str(),
    )
    .unwrap();
    assert_eq!(transitioned["status"], "IN_PLANNING");

    let invalid_args: serde_json::Map<String, serde_json::Value> = serde_json::from_value(
        serde_json::json!({ "task_id": task_id, "status": "IN_WORK" }),
    )
    .unwrap();
    let invalid = client
        .call_tool(CallToolRequestParams::new("transition_task_status").with_arguments(invalid_args))
        .await
        .expect("skipping a stage should still return a tool-level result");
    assert_eq!(invalid.is_error, Some(true));

    client.cancel().await.expect("cancel client");
    server.abort();
}
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cargo test --manifest-path backend/Cargo.toml --test mcp transition_task_status_tool_enforces_workflow_rules`

Expected: failure — `transition_task_status` tool not registered.

- [ ] **Step 3: Make `Status` schema-derivable**

Modify `backend/src/models.rs`. Change the `Status` enum derive (around line 157-159) from:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Status {
```

to:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Status {
```

- [ ] **Step 4: Extract `transition_task_core`**

Modify `backend/src/handlers/tasks.rs`. Replace `transition_task` (lines 121-202) with:

```rust
pub async fn transition_task(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<TransitionRequest>,
) -> Result<Json<TaskResponse>, AppError> {
    Ok(Json(transition_task_core(&state, &id, input.status).await?))
}

pub(crate) async fn transition_task_core(
    state: &AppState,
    id: &str,
    target: Status,
) -> Result<TaskResponse, AppError> {
    let mut connection = state.pool.acquire().await.map_err(AppError::Internal)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(AppError::Internal)?;

    let result = async {
        let task = sqlx::query_as::<_, Task>(
            "SELECT id, project_id, title, description, status, agent, result_summary, created_at, updated_at \
             FROM tasks WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&mut *connection)
        .await
        .map_err(AppError::Internal)?
        .ok_or(AppError::NotFound)?;
        let current: Status = task
            .status
            .parse()
            .expect("database task statuses must be valid");
        if !current.can_transition_to(target) {
            return Err(AppError::InvalidTransition(format!(
                "cannot transition from {current} to {target}"
            )));
        }

        let now = Utc::now().to_rfc3339();
        let updated = sqlx::query(
            "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ?",
        )
        .bind(target.to_string())
        .bind(&now)
        .bind(id)
        .bind(current.to_string())
        .execute(&mut *connection)
        .await
        .map_err(AppError::Internal)?;
        if updated.rows_affected() == 0 {
            return Err(AppError::InvalidTransition(format!(
                "cannot transition from {current} to {target}"
            )));
        }
        sqlx::query(
            "INSERT INTO task_logs (id, task_id, author, message, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(id)
        .bind("system")
        .bind(format!("Status changed from {current} to {target}"))
        .bind(now)
        .execute(&mut *connection)
        .await
        .map_err(AppError::Internal)?;
        Ok(())
    }
    .await;

    match result {
        Ok(()) => {
            sqlx::query("COMMIT")
                .execute(&mut *connection)
                .await
                .map_err(AppError::Internal)?;
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            return Err(error);
        }
    }
    drop(connection);

    task_response(state, fetch_task(state, id).await?).await
}
```

- [ ] **Step 5: Add the MCP tool**

Modify `backend/src/mcp.rs`. Add this method inside `#[tool_router] impl TaskMcpServer { ... }`, after `list_project_tasks`:

```rust
#[tool(
    description = "Move a task to a new workflow status. Only the next stage or any earlier stage (rework) is allowed."
)]
async fn transition_task_status(
    &self,
    Parameters(TransitionTaskStatusParams { task_id, status }): Parameters<
        TransitionTaskStatusParams,
    >,
) -> Result<CallToolResult, McpError> {
    let state = self.state();
    let response = tasks::transition_task_core(&state, &task_id, status)
        .await
        .map_err(to_mcp_error)?;
    json_result(&response)
}
```

Add the params struct next to the others. It needs `crate::models::Status`, so also update the `use crate::{...}` block:

```rust
use crate::{
    error::AppError,
    handlers::{projects, tasks},
    models::{CreateTask, Status},
};
```

```rust
#[derive(serde::Deserialize, schemars::JsonSchema)]
struct TransitionTaskStatusParams {
    task_id: String,
    status: Status,
}
```

- [ ] **Step 6: Run the tests**

Run: `cargo test --manifest-path backend/Cargo.toml --test mcp transition_task_status_tool_enforces_workflow_rules`

Expected: PASS — the valid transition succeeds and returns `IN_PLANNING`; the invalid one comes back as a tool-level error (`is_error == Some(true)`) rather than a transport failure, because `to_mcp_error` maps `AppError::InvalidTransition` to `McpError::invalid_params`, which rmcp reports as a tool error, not a connection failure.

- [ ] **Step 7: Run the full suite and formatter**

Run: `cargo fmt --manifest-path backend/Cargo.toml --check && cargo test --manifest-path backend/Cargo.toml`

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add backend
git commit -m "feat: add transition_task_status MCP tool"
```

---

### Task 5: `add_task_log` MCP tool

**Files:**
- Modify: `backend/src/handlers/tasks.rs:220-248`
- Modify: `backend/src/mcp.rs`
- Modify: `backend/tests/mcp.rs`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/mcp.rs`:

```rust
#[tokio::test]
async fn add_task_log_tool_appends_a_log_entry() {
    let (base_url, server) = support::spawn_http_server(support::state().await).await;
    let project_id = create_project(&base_url).await;

    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(format!("{base_url}/mcp"))
            .custom_headers(support::api_key_header()),
    );
    let client = ClientInfo::default().serve(transport).await.expect("client connects");

    let create_args: serde_json::Map<String, serde_json::Value> = serde_json::from_value(
        serde_json::json!({ "project_id": project_id, "title": "Log me" }),
    )
    .unwrap();
    let created = client
        .call_tool(CallToolRequestParams::new("create_task").with_arguments(create_args))
        .await
        .expect("create_task should succeed");
    let created_task: serde_json::Value = serde_json::from_str(
        created.content.first().unwrap().as_text().unwrap().text.as_str(),
    )
    .unwrap();
    let task_id = created_task["id"].as_str().unwrap().to_owned();

    let log_args: serde_json::Map<String, serde_json::Value> = serde_json::from_value(
        serde_json::json!({ "task_id": task_id, "author": "fixer", "message": "Started implementation" }),
    )
    .unwrap();
    let logged = client
        .call_tool(CallToolRequestParams::new("add_task_log").with_arguments(log_args))
        .await
        .expect("add_task_log should succeed");
    assert_ne!(logged.is_error, Some(true));
    let log: serde_json::Value = serde_json::from_str(
        logged.content.first().unwrap().as_text().unwrap().text.as_str(),
    )
    .unwrap();
    assert_eq!(log["author"], "fixer");
    assert_eq!(log["message"], "Started implementation");

    client.cancel().await.expect("cancel client");
    server.abort();
}
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cargo test --manifest-path backend/Cargo.toml --test mcp add_task_log_tool_appends_a_log_entry`

Expected: failure — `add_task_log` tool not registered.

- [ ] **Step 3: Extract `create_log_core`**

Modify `backend/src/handlers/tasks.rs`. Replace `create_log` (lines 220-248) with:

```rust
pub async fn create_log(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    Json(input): Json<CreateLog>,
) -> Result<impl IntoResponse, AppError> {
    Ok((
        StatusCode::CREATED,
        Json(create_log_core(&state, &task_id, input).await?),
    ))
}

pub(crate) async fn create_log_core(
    state: &AppState,
    task_id: &str,
    input: CreateLog,
) -> Result<TaskLog, AppError> {
    fetch_task(state, task_id).await?;
    validate_log(&input.author, &input.message)?;

    let log = TaskLog {
        id: Uuid::new_v4().to_string(),
        task_id: task_id.to_owned(),
        author: input.author,
        message: input.message,
        created_at: Utc::now().to_rfc3339(),
    };
    sqlx::query(
        "INSERT INTO task_logs (id, task_id, author, message, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&log.id)
    .bind(&log.task_id)
    .bind(&log.author)
    .bind(&log.message)
    .bind(&log.created_at)
    .execute(&state.pool)
    .await
    .map_err(AppError::Internal)?;

    Ok(log)
}
```

- [ ] **Step 4: Add the MCP tool**

Modify `backend/src/mcp.rs`. Add this method inside `#[tool_router] impl TaskMcpServer { ... }`, after `transition_task_status`:

```rust
#[tool(description = "Append a log entry to a task's timeline")]
async fn add_task_log(
    &self,
    Parameters(AddTaskLogParams {
        task_id,
        author,
        message,
    }): Parameters<AddTaskLogParams>,
) -> Result<CallToolResult, McpError> {
    let state = self.state();
    let log = tasks::create_log_core(&state, &task_id, crate::models::CreateLog { author, message })
        .await
        .map_err(to_mcp_error)?;
    json_result(&log)
}
```

Add the params struct next to the others:

```rust
#[derive(serde::Deserialize, schemars::JsonSchema)]
struct AddTaskLogParams {
    task_id: String,
    author: String,
    message: String,
}
```

- [ ] **Step 5: Run the tests**

Run: `cargo test --manifest-path backend/Cargo.toml --test mcp add_task_log_tool_appends_a_log_entry`

Expected: PASS.

- [ ] **Step 6: Run the full suite and formatter**

Run: `cargo fmt --manifest-path backend/Cargo.toml --check && cargo test --manifest-path backend/Cargo.toml`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add backend
git commit -m "feat: add add_task_log MCP tool"
```

---

### Task 6: `add_task_tag` and `remove_task_tag` MCP tools

**Files:**
- Modify: `backend/src/handlers/tasks.rs:250-297`
- Modify: `backend/src/mcp.rs`
- Modify: `backend/tests/mcp.rs`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/mcp.rs`:

```rust
#[tokio::test]
async fn add_task_tag_and_remove_task_tag_tools_manage_tags() {
    let (base_url, server) = support::spawn_http_server(support::state().await).await;
    let project_id = create_project(&base_url).await;

    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(format!("{base_url}/mcp"))
            .custom_headers(support::api_key_header()),
    );
    let client = ClientInfo::default().serve(transport).await.expect("client connects");

    let create_args: serde_json::Map<String, serde_json::Value> = serde_json::from_value(
        serde_json::json!({ "project_id": project_id, "title": "Tag me" }),
    )
    .unwrap();
    let created = client
        .call_tool(CallToolRequestParams::new("create_task").with_arguments(create_args))
        .await
        .expect("create_task should succeed");
    let created_task: serde_json::Value = serde_json::from_str(
        created.content.first().unwrap().as_text().unwrap().text.as_str(),
    )
    .unwrap();
    let task_id = created_task["id"].as_str().unwrap().to_owned();

    let add_args: serde_json::Map<String, serde_json::Value> = serde_json::from_value(
        serde_json::json!({ "task_id": task_id, "name": "NEEDS_USER_INPUT" }),
    )
    .unwrap();
    let tagged = client
        .call_tool(CallToolRequestParams::new("add_task_tag").with_arguments(add_args))
        .await
        .expect("add_task_tag should succeed");
    assert_ne!(tagged.is_error, Some(true));
    let tagged_task: serde_json::Value = serde_json::from_str(
        tagged.content.first().unwrap().as_text().unwrap().text.as_str(),
    )
    .unwrap();
    let tags = tagged_task["tags"].as_array().unwrap();
    assert_eq!(tags.len(), 1);
    assert_eq!(tags[0]["name"], "NEEDS_USER_INPUT");
    let tag_id = tags[0]["id"].as_str().unwrap().to_owned();

    let remove_args: serde_json::Map<String, serde_json::Value> = serde_json::from_value(
        serde_json::json!({ "task_id": task_id, "tag_id": tag_id }),
    )
    .unwrap();
    let removed = client
        .call_tool(CallToolRequestParams::new("remove_task_tag").with_arguments(remove_args))
        .await
        .expect("remove_task_tag should succeed");
    assert_ne!(removed.is_error, Some(true));

    let get_args: serde_json::Map<String, serde_json::Value> =
        serde_json::from_value(serde_json::json!({ "task_id": task_id })).unwrap();
    let refetched = client
        .call_tool(CallToolRequestParams::new("get_task").with_arguments(get_args))
        .await
        .expect("get_task should succeed");
    let refetched_task: serde_json::Value = serde_json::from_str(
        refetched.content.first().unwrap().as_text().unwrap().text.as_str(),
    )
    .unwrap();
    assert!(refetched_task["tags"].as_array().unwrap().is_empty());

    client.cancel().await.expect("cancel client");
    server.abort();
}
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cargo test --manifest-path backend/Cargo.toml --test mcp add_task_tag_and_remove_task_tag_tools_manage_tags`

Expected: failure — `add_task_tag` / `remove_task_tag` tools not registered.

- [ ] **Step 3: Extract `attach_tag_core` and `remove_tag_core`**

Modify `backend/src/handlers/tasks.rs`. Replace `attach_tag` and `remove_tag` (lines 250-297) with:

```rust
pub async fn attach_tag(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
    Json(input): Json<AttachTag>,
) -> Result<Json<TaskResponse>, AppError> {
    Ok(Json(attach_tag_core(&state, &task_id, input.name).await?))
}

pub(crate) async fn attach_tag_core(
    state: &AppState,
    task_id: &str,
    name: String,
) -> Result<TaskResponse, AppError> {
    fetch_task(state, task_id).await?;
    validate_tag_name(&name)?;

    sqlx::query(
        "INSERT INTO tags (id, name, is_system) VALUES (?, ?, 0) ON CONFLICT(name) DO NOTHING",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&name)
    .execute(&state.pool)
    .await
    .map_err(AppError::Internal)?;
    let tag: Tag = sqlx::query_as("SELECT id, name, is_system FROM tags WHERE name = ?")
        .bind(&name)
        .fetch_one(&state.pool)
        .await
        .map_err(AppError::Internal)?;
    sqlx::query(
        "INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?) ON CONFLICT(task_id, tag_id) DO NOTHING",
    )
    .bind(task_id)
    .bind(&tag.id)
    .execute(&state.pool)
    .await
    .map_err(AppError::Internal)?;

    task_response(state, fetch_task(state, task_id).await?).await
}

pub async fn remove_tag(
    State(state): State<AppState>,
    Path((task_id, tag_id)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    remove_tag_core(&state, &task_id, &tag_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn remove_tag_core(
    state: &AppState,
    task_id: &str,
    tag_id: &str,
) -> Result<(), AppError> {
    fetch_task(state, task_id).await?;
    sqlx::query("DELETE FROM task_tags WHERE task_id = ? AND tag_id = ?")
        .bind(task_id)
        .bind(tag_id)
        .execute(&state.pool)
        .await
        .map_err(AppError::Internal)?;
    Ok(())
}
```

- [ ] **Step 4: Add the MCP tools**

Modify `backend/src/mcp.rs`. Add these methods inside `#[tool_router] impl TaskMcpServer { ... }`, after `add_task_log`:

```rust
#[tool(
    description = "Attach a tag to a task (e.g. NEEDS_USER_INPUT, BLOCKED, FAILED, or a custom name). Idempotent."
)]
async fn add_task_tag(
    &self,
    Parameters(AddTaskTagParams { task_id, name }): Parameters<AddTaskTagParams>,
) -> Result<CallToolResult, McpError> {
    let state = self.state();
    let response = tasks::attach_tag_core(&state, &task_id, name)
        .await
        .map_err(to_mcp_error)?;
    json_result(&response)
}

#[tool(description = "Remove a tag from a task")]
async fn remove_task_tag(
    &self,
    Parameters(RemoveTaskTagParams { task_id, tag_id }): Parameters<RemoveTaskTagParams>,
) -> Result<CallToolResult, McpError> {
    let state = self.state();
    tasks::remove_tag_core(&state, &task_id, &tag_id)
        .await
        .map_err(to_mcp_error)?;
    Ok(CallToolResult::success(vec![ContentBlock::text("removed")]))
}
```

Add the params structs next to the others:

```rust
#[derive(serde::Deserialize, schemars::JsonSchema)]
struct AddTaskTagParams {
    task_id: String,
    name: String,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct RemoveTaskTagParams {
    task_id: String,
    tag_id: String,
}
```

- [ ] **Step 5: Run the tests**

Run: `cargo test --manifest-path backend/Cargo.toml --test mcp add_task_tag_and_remove_task_tag_tools_manage_tags`

Expected: PASS.

- [ ] **Step 6: Run the full suite and formatter**

Run: `cargo fmt --manifest-path backend/Cargo.toml --check && cargo test --manifest-path backend/Cargo.toml`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add backend
git commit -m "feat: add add_task_tag and remove_task_tag MCP tools"
```

---

### Task 7: `update_task` MCP tool

**Files:**
- Modify: `backend/src/handlers/tasks.rs` (add `update_task_fields` near `update_task`, lines 70-98)
- Modify: `backend/src/mcp.rs`
- Modify: `backend/tests/mcp.rs`

This tool intentionally has simpler semantics than the REST `PATCH /api/tasks/:id` endpoint: `agent`/`result_summary` fields are only *replaced* when the caller supplies a value; there is no way to explicitly clear them back to `null` (the REST API's `PatchField` tri-state exists for that, and is out of scope for MCP v1 per the design spec). `title`/`description` are untouched by this tool — use `create_task` for those.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/mcp.rs`:

```rust
#[tokio::test]
async fn update_task_tool_sets_agent_and_result_summary_without_touching_title() {
    let (base_url, server) = support::spawn_http_server(support::state().await).await;
    let project_id = create_project(&base_url).await;

    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(format!("{base_url}/mcp"))
            .custom_headers(support::api_key_header()),
    );
    let client = ClientInfo::default().serve(transport).await.expect("client connects");

    let create_args: serde_json::Map<String, serde_json::Value> = serde_json::from_value(
        serde_json::json!({ "project_id": project_id, "title": "Update me" }),
    )
    .unwrap();
    let created = client
        .call_tool(CallToolRequestParams::new("create_task").with_arguments(create_args))
        .await
        .expect("create_task should succeed");
    let created_task: serde_json::Value = serde_json::from_str(
        created.content.first().unwrap().as_text().unwrap().text.as_str(),
    )
    .unwrap();
    let task_id = created_task["id"].as_str().unwrap().to_owned();

    let update_args: serde_json::Map<String, serde_json::Value> = serde_json::from_value(
        serde_json::json!({ "task_id": task_id, "agent": "fixer", "result_summary": "Done" }),
    )
    .unwrap();
    let updated = client
        .call_tool(CallToolRequestParams::new("update_task").with_arguments(update_args))
        .await
        .expect("update_task should succeed");
    assert_ne!(updated.is_error, Some(true));
    let updated_task: serde_json::Value = serde_json::from_str(
        updated.content.first().unwrap().as_text().unwrap().text.as_str(),
    )
    .unwrap();
    assert_eq!(updated_task["title"], "Update me");
    assert_eq!(updated_task["agent"], "fixer");
    assert_eq!(updated_task["result_summary"], "Done");

    client.cancel().await.expect("cancel client");
    server.abort();
}
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cargo test --manifest-path backend/Cargo.toml --test mcp update_task_tool_sets_agent_and_result_summary_without_touching_title`

Expected: failure — `update_task` tool not registered.

- [ ] **Step 3: Add `update_task_fields`**

Modify `backend/src/handlers/tasks.rs`. Add this new function directly after the existing `update_task` handler (after line 98, before `list_project_tasks`):

```rust
pub(crate) async fn update_task_fields(
    state: &AppState,
    task_id: &str,
    agent: Option<String>,
    result_summary: Option<String>,
) -> Result<TaskResponse, AppError> {
    let task = fetch_task(state, task_id).await?;
    let agent = agent.or(task.agent);
    let result_summary = result_summary.or(task.result_summary);

    sqlx::query("UPDATE tasks SET agent = ?, result_summary = ?, updated_at = ? WHERE id = ?")
        .bind(&agent)
        .bind(&result_summary)
        .bind(Utc::now().to_rfc3339())
        .bind(task_id)
        .execute(&state.pool)
        .await
        .map_err(AppError::Internal)?;

    task_response(state, fetch_task(state, task_id).await?).await
}
```

- [ ] **Step 4: Add the MCP tool**

Modify `backend/src/mcp.rs`. Add this method inside `#[tool_router] impl TaskMcpServer { ... }`, after `remove_task_tag`:

```rust
#[tool(
    description = "Set a task's agent name and/or result summary. Fields left out of the call keep their current value."
)]
async fn update_task(
    &self,
    Parameters(UpdateTaskParams {
        task_id,
        agent,
        result_summary,
    }): Parameters<UpdateTaskParams>,
) -> Result<CallToolResult, McpError> {
    let state = self.state();
    let response = tasks::update_task_fields(&state, &task_id, agent, result_summary)
        .await
        .map_err(to_mcp_error)?;
    json_result(&response)
}
```

Add the params struct next to the others:

```rust
#[derive(serde::Deserialize, schemars::JsonSchema)]
struct UpdateTaskParams {
    task_id: String,
    agent: Option<String>,
    result_summary: Option<String>,
}
```

- [ ] **Step 5: Run the tests**

Run: `cargo test --manifest-path backend/Cargo.toml --test mcp update_task_tool_sets_agent_and_result_summary_without_touching_title`

Expected: PASS.

- [ ] **Step 6: Run the full suite and formatter**

Run: `cargo fmt --manifest-path backend/Cargo.toml --check && cargo test --manifest-path backend/Cargo.toml`

Expected: all tests pass — this is the last tool from the v1 list, so this run exercises every REST handler refactor together.

- [ ] **Step 7: Commit**

```bash
git add backend
git commit -m "feat: add update_task MCP tool"
```

---

### Task 8: Document the MCP endpoint and verify the production build

**Files:**
- Modify: `README.md`
- No code changes

- [ ] **Step 1: Add the MCP section to the README**

Modify `README.md`. Add this section after the "Workflow and attention tags" section (after line 54):

```markdown

## MCP server for AI agents

Agents can self-report their own progress (create tasks, move status, add logs, set tags,
update agent/result) by connecting to the built-in MCP server instead of calling the REST
API directly. It is mounted at `/mcp` on the same binary and port as the REST API, and uses
the same `X-Api-Key` authentication.

Example client configuration (Claude Code / opencode style):

```json
{
  "mcpServers": {
    "ai-task-tracker": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "X-Api-Key": "replace-with-your-key"
      }
    }
  }
}
```

Available tools: `create_task`, `get_task`, `list_projects`, `list_project_tasks`,
`transition_task_status`, `add_task_log`, `add_task_tag`, `remove_task_tag`, `update_task`.
Each tool enforces the same validation and workflow-transition rules as the REST API.
```

- [ ] **Step 2: Run the full verification suite**

Run: `npm run build --prefix frontend && cargo fmt --manifest-path backend/Cargo.toml --check && cargo test --manifest-path backend/Cargo.toml && cargo build --manifest-path backend/Cargo.toml`

Expected: frontend build succeeds, Rust formatting is clean, every backend test passes (REST + MCP), and the production binary builds.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document the MCP endpoint for AI agents"
```

---

## Plan self-review

- **Spec coverage:** All nine tools from the spec's table are covered (Tasks 2, 3, 4, 5, 6, 7). Auth reuse and shared business logic are covered in Task 1 (mounting) and each task's `_core` extraction. Error-vocabulary mapping is covered by `to_mcp_error` in Task 2. Documentation is covered in Task 8. Testing strategy (integration tests via a real MCP client against a real bound port) is covered in every task.
- **Out-of-scope protection:** No project creation/deletion tools, no orchestrator-facing `list_attention` tool, no dedicated MCP API-key scope — all explicitly deferred per the design spec.
- **Consistency:** Every `_core` function signature introduced in one task is used with the same name and argument order by the MCP tool added in that same task, and by the REST handler that now delegates to it. `AppError` variants and their `to_mcp_error` mapping are defined once (Task 2) and reused unchanged by every later task.
