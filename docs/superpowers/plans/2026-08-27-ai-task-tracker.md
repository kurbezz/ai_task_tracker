# AI Task Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-hosted personal tracker for tasks executed by AI agents, with a Rust/Axum API, SQLite storage, API-key authentication, and a React kanban UI.

**Architecture:** The Rust backend owns the workflow rules, SQLite schema, API-key validation, and REST API. The React/Vite SPA consumes that API; its production build is embedded in the Axum binary and served as an SPA fallback. Tasks belong to projects, maintain append-only logs, and use tags for attention/blocking/failure signals rather than extra workflow statuses.

**Tech Stack:** Rust, Axum 0.7, sqlx/SQLite, Tokio, Serde, UUID, React, TypeScript, Vite, react-router-dom, rust-embed.

---

## File structure

```
backend/
  Cargo.toml                         Rust dependencies and build settings
  migrations/0001_initial.sql        SQLite schema and system tag seed data
  src/
    lib.rs                           AppState, router, API route wiring
    main.rs                          DB setup and HTTP server entry point
    db.rs                            SQLite pool setup and initial API key seed
    error.rs                         JSON API error envelope
    auth.rs                          X-Api-Key middleware and SHA-256 hashing
    models.rs                        API/DB types and workflow Status enum
    handlers/
      mod.rs                         Handler module exports
      projects.rs                    Project CRUD handlers
      tasks.rs                       Task, status, log, tag, attention handlers
      tags.rs                        Tag list handler
    static_files.rs                  Embedded Vite asset serving
  tests/
    support/mod.rs                   In-memory DB/router/request helpers
    health_and_auth.rs               Health and authentication integration tests
    projects.rs                      Project API integration tests
    tasks.rs                         Task and status transition tests
    logs_and_tags.rs                 Timeline/tag/attention integration tests
frontend/
  package.json                       SPA dependencies and scripts
  vite.config.ts                     Development API proxy
  tsconfig.json                      TypeScript compiler settings
  index.html                         Vite page shell
  src/
    main.tsx                         React bootstrap
    App.tsx                          Routes and app shell
    api.ts                           Typed REST client
    types.ts                         API model types and status metadata
    styles.css                       Application styles
    pages/ProjectsPage.tsx           Project selection and creation
    pages/BoardPage.tsx              Project kanban board and task creation
    pages/AttentionPage.tsx          Cross-project attention queue
    components/TaskCard.tsx          Board task card
    components/TaskDetail.tsx        Task detail, workflow, logs, tags
    components/TagBadge.tsx          Reusable attention-aware tag badge
README.md                            Local development and production instructions
```

### Task 1: Create the backend crate and executable health check

**Files:**
- Create: `backend/Cargo.toml`
- Create: `backend/src/lib.rs`
- Create: `backend/src/main.rs`
- Create: `backend/tests/health_and_auth.rs`

- [ ] **Step 1: Write the failing health-check test**

```rust
// backend/tests/health_and_auth.rs
use axum::{body::Body, http::{Request, StatusCode}};
use tower::ServiceExt;

#[tokio::test]
async fn health_check_is_public_and_returns_ok() {
    let app = ai_task_tracker::build_router(ai_task_tracker::AppState::for_test());
    let response = app
        .oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
}
```

- [ ] **Step 2: Run the test and confirm it fails because the crate does not exist**

Run: `cargo test --manifest-path backend/Cargo.toml --test health_and_auth`

Expected: failure mentioning the missing manifest or `ai_task_tracker` crate.

- [ ] **Step 3: Create the minimal crate and health route**

```toml
# backend/Cargo.toml
[package]
name = "ai-task-tracker"
version = "0.1.0"
edition = "2021"

[lib]
name = "ai_task_tracker"
path = "src/lib.rs"

[[bin]]
name = "ai-task-tracker"
path = "src/main.rs"

[dependencies]
axum = "0.7"
tokio = { version = "1", features = ["macros", "rt-multi-thread", "net"] }
sqlx = { version = "0.8", features = ["runtime-tokio-rustls", "sqlite", "uuid", "chrono", "migrate"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
uuid = { version = "1", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde"] }
sha2 = "0.10"
rand = "0.8"
hex = "0.4"
rust-embed = "8"
mime_guess = "2"
http = "1"

[dev-dependencies]
tower = { version = "0.5", features = ["util"] }
http-body-util = "0.1"
```

```rust
// backend/src/lib.rs
use axum::{routing::get, Router};

#[derive(Clone)]
pub struct AppState;

impl AppState {
    pub fn for_test() -> Self { Self }
}

pub fn build_router(_state: AppState) -> Router {
    Router::new().route("/health", get(|| async { "ok" }))
}
```

```rust
// backend/src/main.rs
use ai_task_tracker::{build_router, AppState};

#[tokio::main]
async fn main() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000").await.unwrap();
    axum::serve(listener, build_router(AppState::for_test())).await.unwrap();
}
```

- [ ] **Step 4: Run the test and formatter**

Run: `cargo fmt --manifest-path backend/Cargo.toml --check && cargo test --manifest-path backend/Cargo.toml --test health_and_auth`

Expected: formatter succeeds; one passing test.

- [ ] **Step 5: Commit**

```bash
git add backend
git commit -m "chore: initialize Rust tracker backend"
```

### Task 2: Add SQLite schema, real application state, and workflow types

**Files:**
- Create: `backend/migrations/0001_initial.sql`
- Create: `backend/src/db.rs`
- Create: `backend/src/models.rs`
- Modify: `backend/src/lib.rs`
- Modify: `backend/src/main.rs`
- Create: `backend/tests/support/mod.rs`
- Modify: `backend/tests/health_and_auth.rs`

- [ ] **Step 1: Write failing tests for workflow transitions**

```rust
// append to backend/tests/health_and_auth.rs
use ai_task_tracker::models::Status;

#[test]
fn status_allows_one_step_forward_and_any_backward_rework() {
    assert!(Status::Todo.can_transition_to(Status::InPlanning));
    assert!(Status::WaitReview.can_transition_to(Status::InWork));
    assert!(!Status::Todo.can_transition_to(Status::ReadyToImplement));
    assert!(!Status::Done.can_transition_to(Status::Done));
}
```

- [ ] **Step 2: Run the test and confirm the missing model failure**

Run: `cargo test --manifest-path backend/Cargo.toml --test health_and_auth status_allows`

Expected: compilation error for missing `models::Status`.

- [ ] **Step 3: Add schema and typed status model**

```sql
-- backend/migrations/0001_initial.sql
PRAGMA foreign_keys = ON;
CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  agent TEXT,
  result_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE task_logs (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE tags (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  is_system INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO tags (id, name, is_system) VALUES
  ('00000000-0000-0000-0000-000000000001', 'NEEDS_USER_INPUT', 1),
  ('00000000-0000-0000-0000-000000000002', 'BLOCKED', 1),
  ('00000000-0000-0000-0000-000000000003', 'FAILED', 1);
```

```rust
// backend/src/models.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Status { Todo, InPlanning, ReadyToImplement, InWork, WaitReview, ReadyToDeploy, Done }

impl Status {
    pub const ORDER: [Self; 7] = [Self::Todo, Self::InPlanning, Self::ReadyToImplement,
        Self::InWork, Self::WaitReview, Self::ReadyToDeploy, Self::Done];
    pub fn can_transition_to(self, target: Self) -> bool {
        let from = Self::ORDER.iter().position(|s| *s == self).unwrap();
        let to = Self::ORDER.iter().position(|s| *s == target).unwrap();
        to + 1 == from || to == from + 1
    }
}

impl std::fmt::Display for Status {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", serde_json::to_string(self).unwrap().trim_matches('"'))
    }
}
impl std::str::FromStr for Status {
    type Err = String;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        serde_json::from_value(serde_json::Value::String(value.to_owned())).map_err(|_| format!("unknown status: {value}"))
    }
}
```

```rust
// backend/src/db.rs
use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};
use std::path::Path;

pub async fn connect(database_url: &str) -> Result<SqlitePool, sqlx::Error> {
    if let Some(path) = database_url.strip_prefix("sqlite:") {
        if path != ":memory:" { if let Some(parent) = Path::new(path).parent() { std::fs::create_dir_all(parent).ok(); } }
    }
    SqlitePoolOptions::new().max_connections(5).connect(database_url).await
}

pub async fn migrate(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::migrate!("./migrations").run(pool).await
}
```

Replace `AppState` in `lib.rs` with `#[derive(Clone)] pub struct AppState { pub pool: sqlx::SqlitePool }`; expose `pub mod db; pub mod models;`. Change `main.rs` to use `db::connect("sqlite:data/tracker.db")`, run `db::migrate`, and pass the pool in `AppState`.

- [ ] **Step 4: Add a test DB helper and run migrations**

```rust
// backend/tests/support/mod.rs
use ai_task_tracker::{db, AppState};

pub async fn state() -> AppState {
    let pool = db::connect("sqlite::memory:").await.unwrap();
    db::migrate(&pool).await.unwrap();
    AppState { pool }
}
```

Replace `AppState::for_test()` in the health test with `support::state().await` and add `mod support;`.

- [ ] **Step 5: Verify and commit**

Run: `cargo fmt --manifest-path backend/Cargo.toml --check && cargo test --manifest-path backend/Cargo.toml`

Expected: all tests pass.

```bash
git add backend
git commit -m "feat: add SQLite schema and workflow model"
```

### Task 3: Add JSON errors and API-key authentication

**Files:**
- Create: `backend/src/error.rs`
- Create: `backend/src/auth.rs`
- Modify: `backend/src/lib.rs`
- Modify: `backend/src/db.rs`
- Modify: `backend/tests/health_and_auth.rs`

- [ ] **Step 1: Write authentication tests**

```rust
#[tokio::test]
async fn api_routes_reject_missing_or_invalid_key() {
    let state = support::state().await;
    let app = ai_task_tracker::build_router(state);
    for key in [None, Some("wrong")] {
        let mut request = Request::builder().uri("/api/projects").body(Body::empty()).unwrap();
        if let Some(key) = key { request.headers_mut().insert("x-api-key", key.parse().unwrap()); }
        assert_eq!(app.clone().oneshot(request).await.unwrap().status(), StatusCode::UNAUTHORIZED);
    }
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cargo test --manifest-path backend/Cargo.toml --test health_and_auth api_routes_rejects`

Expected: route does not exist or returns a non-401 response.

- [ ] **Step 3: Implement errors, hashing, key seeding, and middleware**

`error.rs` must define a serializable `ErrorBody { error: String, code: String }` and an `AppError` enum with `Unauthorized`, `NotFound`, `Validation(String)`, `InvalidTransition(String)`, and `Internal(sqlx::Error)` variants. Its `IntoResponse` implementation returns JSON errors with 401, 404, 422, 409, and 500 respectively.

`auth.rs` must define:

```rust
pub fn hash_key(value: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(value.as_bytes()))
}
```

and a middleware that reads `X-Api-Key`, hashes it, checks `SELECT 1 FROM api_keys WHERE key_hash = ?`, and returns `AppError::Unauthorized` when absent or invalid. Add `db::ensure_initial_api_key`: when `api_keys` is empty, generate 32 random bytes, encode them with `hex`, store only the hash with label `initial`, and print `Initial API key (save it now): <key>` once.

Nest all API routes under `/api` in `lib.rs` and apply this middleware only to that nest; `/health` stays public. Temporarily add `GET /api/projects` returning `[]` so the auth test has a protected route.

- [ ] **Step 4: Add a valid-key helper and verify**

Have `support::state()` insert `hash_key("test-key")` into `api_keys`; update the test to assert a request with `X-Api-Key: test-key` gets `200 OK`.

Run: `cargo fmt --manifest-path backend/Cargo.toml --check && cargo test --manifest-path backend/Cargo.toml --test health_and_auth`

Expected: health and all three auth cases pass.

- [ ] **Step 5: Commit**

```bash
git add backend
git commit -m "feat: protect API routes with API keys"
```

### Task 4: Implement project CRUD

**Files:**
- Create: `backend/src/handlers/mod.rs`
- Create: `backend/src/handlers/projects.rs`
- Modify: `backend/src/lib.rs`
- Create: `backend/tests/projects.rs`

- [ ] **Step 1: Write project integration tests**

Test `POST /api/projects` with `{"name":"Tracker","description":"Work"}` returns `201`, a UUID, and the supplied fields; `GET /api/projects` contains it; `PATCH /api/projects/:id` changes its name; `DELETE /api/projects/:id` returns `204`; and a whitespace-only name returns `422`. Build authenticated JSON requests in `tests/support/mod.rs` using `X-Api-Key: test-key`.

- [ ] **Step 2: Run and confirm failure**

Run: `cargo test --manifest-path backend/Cargo.toml --test projects`

Expected: failure because project routes are unimplemented.

- [ ] **Step 3: Implement handlers and route wiring**

Define `Project { id: Uuid, name: String, description: Option<String>, created_at: String }`, `CreateProject { name: String, description: Option<String> }`, and `UpdateProject { name: Option<String>, description: Option<String> }`. In `projects.rs`, use parameterized sqlx queries; generate `Uuid::new_v4()` and `Utc::now().to_rfc3339()` on creation. Reject empty trimmed names with `AppError::Validation("project name is required".into())`. Wire:

```
GET/POST    /projects
GET/PATCH/DELETE /projects/:id
```

Return `404` for unknown IDs. Deleting a project relies on SQLite cascade deletes for tasks/logs/tag joins.

- [ ] **Step 4: Verify and commit**

Run: `cargo fmt --manifest-path backend/Cargo.toml --check && cargo test --manifest-path backend/Cargo.toml --test projects`

Expected: all project tests pass.

```bash
git add backend
git commit -m "feat: add project CRUD API"
```

### Task 5: Implement task CRUD and workflow transitions

**Files:**
- Create: `backend/src/handlers/tasks.rs`
- Modify: `backend/src/handlers/mod.rs`
- Modify: `backend/src/lib.rs`
- Create: `backend/tests/tasks.rs`

- [ ] **Step 1: Write task and status tests**

Create a project through the API, then assert:

1. `POST /api/tasks` with `project_id`, `title`, `description`, and `agent` returns `201`, `status: "TODO"`, and an empty tag list.
2. `GET /api/projects/:id/tasks` returns that task.
3. `PATCH /api/tasks/:id` updates `agent` and `result_summary` without changing status.
4. `POST /api/tasks/:id/status` with `{"status":"IN_PLANNING"}` returns `200`; the response has the new status and a system log saying `Status changed from TODO to IN_PLANNING`.
5. Skipping to `IN_WORK` returns `409` with `code: "INVALID_TRANSITION"`; moving from `IN_WORK` back to `TODO` is allowed.
6. Missing project/task returns `404`; blank title returns `422`.

- [ ] **Step 2: Run and confirm failure**

Run: `cargo test --manifest-path backend/Cargo.toml --test tasks`

Expected: 404s because task routes do not yet exist.

- [ ] **Step 3: Implement task handlers**

Define `Task`, `TaskResponse { task fields..., tags: Vec<Tag> }`, `CreateTask`, `UpdateTask`, and `TransitionRequest { status: Status }` in `models.rs`. Implement the following routes in `tasks.rs`:

```
POST /tasks
GET  /tasks/:id
PATCH /tasks/:id
GET  /projects/:id/tasks
POST /tasks/:id/status
```

Creation validates the parent project exists, stores default status `TODO`, and creates a response with an empty tag array. Update only permits `title`, `description`, `agent`, and `result_summary`; absent fields preserve the stored value. Transition parses the stored status, calls `current.can_transition_to(target)`, updates `updated_at`, and inserts a `task_logs` row with `author = "system"`. No endpoint can directly write arbitrary `status` through PATCH.

- [ ] **Step 4: Verify and commit**

Run: `cargo fmt --manifest-path backend/Cargo.toml --check && cargo test --manifest-path backend/Cargo.toml --test tasks`

Expected: task CRUD and workflow tests pass.

```bash
git add backend
git commit -m "feat: add tasks and workflow transitions"
```

### Task 6: Implement task logs, tags, and the attention query

**Files:**
- Create: `backend/src/handlers/tags.rs`
- Modify: `backend/src/handlers/tasks.rs`
- Modify: `backend/src/handlers/mod.rs`
- Modify: `backend/src/lib.rs`
- Create: `backend/tests/logs_and_tags.rs`

- [ ] **Step 1: Write integration tests**

Create a task, then assert:

1. `POST /api/tasks/:id/logs` with `{"author":"coder","message":"Started"}` returns `201`; `GET /logs` returns the entry in chronological order.
2. `POST /api/tasks/:id/tags` with `{"name":"NEEDS_USER_INPUT"}` attaches the seeded system tag and is idempotent.
3. Posting `{"name":"waiting-on-design"}` creates and attaches a non-system tag; `GET /api/tags` lists it and the three seeded system tags.
4. `DELETE /api/tasks/:id/tags/:tag_id` returns `204` and removes the tag.
5. Tag one task `NEEDS_USER_INPUT`, another `FAILED`, and a third custom tag; `GET /api/tasks/needs-attention` returns only the first two and includes their project names.
6. Empty log author/message and empty tag names return `422`.

- [ ] **Step 2: Run and confirm failure**

Run: `cargo test --manifest-path backend/Cargo.toml --test logs_and_tags`

Expected: failures because the routes are not implemented.

- [ ] **Step 3: Implement logs and tags**

Add these routes:

```
GET/POST /tasks/:id/logs
POST     /tasks/:id/tags
DELETE   /tasks/:id/tags/:tag_id
GET      /tags
GET      /tasks/needs-attention
```

`POST /tags` is intentionally not exposed: attaching a name uses `INSERT ... ON CONFLICT(name) DO NOTHING` plus a select, creating only non-system custom tags. Reject an attempt to create a case-insensitive system-tag lookalike such as `needs_user_input`; clients must use the canonical system name. The attention query filters exact tag names `NEEDS_USER_INPUT`, `BLOCKED`, `FAILED`, returns a task once even if it has several matching tags (`SELECT DISTINCT`), and includes `project_name`.

- [ ] **Step 4: Verify full backend suite and commit**

Run: `cargo fmt --manifest-path backend/Cargo.toml --check && cargo test --manifest-path backend/Cargo.toml`

Expected: all integration and unit tests pass.

```bash
git add backend
git commit -m "feat: add task logs tags and attention API"
```

### Task 7: Scaffold the typed React SPA

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/tsconfig.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/index.html`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/types.ts`
- Create: `frontend/src/api.ts`
- Create: `frontend/src/styles.css`

- [ ] **Step 1: Create the Vite project files**

Use React 18, `react-router-dom`, Vite, TypeScript, and `@vitejs/plugin-react`. `package.json` must define `dev`, `build`, and `preview` scripts. `vite.config.ts` must proxy `/api` to `http://127.0.0.1:3000`.

- [ ] **Step 2: Define models and the client**

`types.ts` must define `Status` as the seven uppercase API strings, `Project`, `Tag`, `Task`, `TaskLog`, and `AttentionItem`. Export `STATUS_ORDER` in the workflow order and `STATUS_LABELS` for readable UI labels.

`api.ts` must read `import.meta.env.VITE_API_KEY`, attach it as `X-Api-Key`, JSON-encode request bodies, and throw `new Error(body.error)` for non-2xx API responses. Export functions for every API route consumed below (`listProjects`, `createProject`, `listProjectTasks`, `createTask`, `getTask`, `updateTask`, `transitionTask`, `listLogs`, `addLog`, `addTag`, `removeTag`, `listAttention`).

- [ ] **Step 3: Add routes and baseline error styling**

`App.tsx` provides navigation to `/`, `/projects/:projectId`, and `/attention`; use a visible error banner per page, not silent failures. `styles.css` establishes the page shell, buttons, forms, modal, kanban grid, cards, and a responsive single-column layout under 900px.

- [ ] **Step 4: Verify development build**

Run: `npm install --prefix frontend && npm run build --prefix frontend`

Expected: Vite produces `frontend/dist/` without TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add frontend
git commit -m "feat: scaffold tracker React application"
```

### Task 8: Build the project list and kanban board

**Files:**
- Create: `frontend/src/pages/ProjectsPage.tsx`
- Create: `frontend/src/pages/BoardPage.tsx`
- Create: `frontend/src/components/TaskCard.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`

- [ ] **Step 1: Implement ProjectsPage**

Fetch projects on mount. Render names/descriptions as links to `/projects/:projectId` and a form with name and optional description. After successful creation, clear the form and append/refetch the project list. Render an explicit empty state: `No projects yet. Create one to start tracking AI work.`

- [ ] **Step 2: Implement board layout and task creation**

`BoardPage` reads `projectId`, fetches its tasks, and creates one column for every `STATUS_ORDER` value. Provide a compact task form with title, optional description, and optional agent; submission calls `createTask`, places the new TODO task in the board, and clears fields. The task board must not implement drag-and-drop in v1; status is changed from the detail panel to preserve API validation.

- [ ] **Step 3: Implement TaskCard**

Display title, an `Agent: <agent>` label only when assigned, and its tags. Clicking calls `onSelect(task.id)`. `NEEDS_USER_INPUT`, `BLOCKED`, and `FAILED` tags must have visually distinct warning/error styles via the reusable badge in the next task.

- [ ] **Step 4: Verify build and manual flow**

Run: `npm run build --prefix frontend`

Manual check: with backend running and `frontend/.env` containing `VITE_API_KEY=<key>`, create a project, create a task, refresh, and confirm it remains in the TODO column.

- [ ] **Step 5: Commit**

```bash
git add frontend
git commit -m "feat: add project board and task creation UI"
```

### Task 9: Build task detail, logs, tags, and attention queue

**Files:**
- Create: `frontend/src/components/TagBadge.tsx`
- Create: `frontend/src/components/TaskDetail.tsx`
- Create: `frontend/src/pages/AttentionPage.tsx`
- Modify: `frontend/src/pages/BoardPage.tsx`
- Modify: `frontend/src/styles.css`

- [ ] **Step 1: Implement TagBadge**

Render a tag name with class `tag--needs-input`, `tag--blocked`, `tag--failed`, `tag--system`, or `tag--custom`. System attention tags must be recognizable without relying only on colour (include concise text/icon treatment).

- [ ] **Step 2: Implement TaskDetail modal/panel**

When a card is selected, fetch its latest task detail and logs. Render description, agent, result summary, tags, and logs. Include:

- A status select containing only current status plus statuses allowed by the same rule as the backend (next stage and any earlier stage); call `transitionTask` and refresh the board on success.
- An add-log form requiring author and message.
- An add-tag input calling `addTag`.
- A remove action beside every nonessential tag calling `removeTag`.
- Editable agent and result summary saved through `updateTask`.

Every mutation refreshes the panel and shows its thrown API error in the panel rather than losing user input silently.

- [ ] **Step 3: Implement AttentionPage**

Call `listAttention` and render a cross-project queue showing project name, task title, current status, agent, and attention tag badges. Link each item to `/projects/:projectId` (the board opens; direct detail deep-linking is explicitly out of scope for v1). Include an empty state when no task needs attention.

- [ ] **Step 4: Verify build and manual workflow**

Run: `npm run build --prefix frontend`

Manual check: create a task, advance it TODO → IN_PLANNING, add a log and `NEEDS_USER_INPUT`, then confirm it appears in `/attention`; remove the tag and confirm it disappears after refresh.

- [ ] **Step 5: Commit**

```bash
git add frontend
git commit -m "feat: add task detail logs tags and attention queue"
```

### Task 10: Embed the frontend and document local operation

**Files:**
- Create: `backend/src/static_files.rs`
- Modify: `backend/src/lib.rs`
- Modify: `backend/Cargo.toml`
- Create: `README.md`

- [ ] **Step 1: Build the frontend before compiling embedded assets**

Run: `npm run build --prefix frontend`

Expected: `frontend/dist/index.html` exists.

- [ ] **Step 2: Implement SPA asset fallback**

Use `rust_embed::RustEmbed` with `#[folder = "../frontend/dist/"]`. `static_files.rs` must return a response with a MIME type from `mime_guess` when an asset exists. When no asset exists, serve `index.html` so React routes work after a browser refresh. Do not let this fallback intercept `/api/*`; API routes must remain registered before `fallback`.

Add `pub mod static_files;` and `.fallback(static_files::serve)` in `build_router` after all routes. The fallback must return `404` only if `index.html` is absent, which indicates the caller did not build the frontend.

- [ ] **Step 3: Write README instructions**

Document these exact workflows:

```bash
# backend development terminal
DATABASE_URL=sqlite:data/tracker.db cargo run --manifest-path backend/Cargo.toml

# frontend development terminal; put the printed initial API key in frontend/.env
VITE_API_KEY=replace-with-your-key
npm install --prefix frontend
npm run dev --prefix frontend

# production-style single binary
npm run build --prefix frontend
cargo run --manifest-path backend/Cargo.toml
```

Also document the API key header, the seven-stage workflow, the three system tags, and that failures use `FAILED` tag + a log rather than a terminal status.

- [ ] **Step 4: Verify the production build and full test suite**

Run: `npm run build --prefix frontend && cargo fmt --manifest-path backend/Cargo.toml --check && cargo test --manifest-path backend/Cargo.toml && cargo build --manifest-path backend/Cargo.toml`

Expected: frontend build, Rust formatting, all backend tests, and binary build succeed.

- [ ] **Step 5: Manual smoke test the single server**

Run: `cargo run --manifest-path backend/Cargo.toml`

Open `http://127.0.0.1:3000/health` and `http://127.0.0.1:3000/`. Confirm the health endpoint says `ok`, the React app loads, and browser refresh on `/attention` still loads the SPA. Stop the process.

- [ ] **Step 6: Commit**

```bash
git add backend frontend README.md
git commit -m "feat: package tracker as a single binary"
```

## Plan self-review

- **Spec coverage:** projects (Task 4), tasks/agent/result (Task 5), fixed status workflow (Tasks 2 and 5), API keys (Task 3), logs/tags/system attention states (Task 6), project board/detail/attention UI (Tasks 8–9), embedded deployment (Task 10), backend integration testing (Tasks 1–6).
- **Out-of-scope protection:** no users/roles, dependency graph, costs/tokens, notifications, drag-and-drop, or frontend test suite introduced.
- **Consistency:** API and TypeScript status values use the same seven uppercase serialized strings. The backend alone validates transitions; the UI only offers transitions the backend will accept.
