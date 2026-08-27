# MCP Agent Integration Design

**Goal:** Let AI agents (Claude Code, opencode, etc.) self-report their own work into the AI Task Tracker — create tasks, move status, add logs, and set attention tags — by calling an MCP server, without hand-writing REST calls.

**Non-goals:** Project creation/deletion via MCP (projects stay human-managed through the SPA). Orchestrator-side querying tools (list-attention-for-triage) are out of scope for v1; can be added later using the same pattern.

## Architecture

The MCP server is **embedded in the existing Rust/Axum backend**, not a separate process. It reuses the same `AppState`, SQLite pool, and `X-Api-Key` authentication as the REST API — there is exactly one server, one auth mechanism, and one source of truth for business rules.

- **Crate:** `rmcp` (official Rust MCP SDK), features `server`, `transport-streamable-http-server`.
- **New module:** `backend/src/mcp.rs` — defines `TaskMcpServer { pool: SqlitePool }` with a `#[tool_router]` impl and `#[tool_handler]` `ServerHandler`.
- **Mounting:** in `lib.rs`, build a `StreamableHttpService::new(move || Ok(TaskMcpServer { pool: pool.clone() }), LocalSessionManager::default().into(), StreamableHttpServerConfig::default())` and `.nest_service("/mcp", mcp_service)`, wrapped with the same `auth::require_api_key` middleware layer used for the `/api` nest (pattern confirmed against `rust-sdk`'s `simple_auth_streamhttp.rs` example: `middleware::from_fn_with_state` composes transparently with `StreamableHttpService` because it implements `tower::Service`).
- **Shared business logic:** status-transition validation, tag validation (system vs. custom name collisions), and project/task existence checks currently live inside `handlers/tasks.rs`, `handlers/projects.rs`, `handlers/tags.rs`. These are extracted into plain async core functions (e.g. `tasks::core::create_task(pool, params) -> Result<TaskResponse, AppError>`) that both the Axum JSON handlers and the MCP tool methods call. No business rule is duplicated between REST and MCP.

## Tools (v1)

All tools operate on the same DB rows as the REST API and enforce the same rules (one-step-forward-or-any-rework transitions, canonical system tag names, required-field validation).

| Tool | Params | Mirrors |
|---|---|---|
| `create_task` | `project_id, title, description?, agent?` | `POST /api/tasks` |
| `get_task` | `task_id` | `GET /api/tasks/:id` |
| `list_projects` | — | `GET /api/projects` |
| `list_project_tasks` | `project_id` | `GET /api/projects/:id/tasks` |
| `transition_task_status` | `task_id, status` | `POST /api/tasks/:id/status` |
| `add_task_log` | `task_id, author, message` | `POST /api/tasks/:id/logs` |
| `add_task_tag` | `task_id, name` | `POST /api/tasks/:id/tags` |
| `remove_task_tag` | `task_id, tag_id` | `DELETE /api/tasks/:id/tags/:tag_id` |
| `update_task` | `task_id, agent?, result_summary?` | `PATCH /api/tasks/:id` |

Tool parameter structs use `serde::Deserialize` + `schemars::JsonSchema` so rmcp can auto-generate JSON schemas for client-side tool discovery.

## Auth

Identical to REST: clients send `X-Api-Key: <key>` on every HTTP request to `/mcp`. The existing middleware hashes and checks it against `api_keys` before the request reaches rmcp's session/routing layer. No new key type or scope in v1 — same key used for the SPA works for MCP clients. (A dedicated `scope=mcp` key type was considered and deferred; can be added later without breaking existing clients if the need arises.)

## Error handling

`AppError` (already covers `Unauthorized`, `NotFound`, `Validation`, `InvalidTransition`, `Internal`) is mapped to an MCP tool error result carrying the same message text used in the REST JSON error body — agents see one consistent error vocabulary regardless of transport.

## Testing

- `backend/tests/mcp.rs`: integration tests that boot the full Axum router (as existing tests already do via `support::state()`), send raw MCP JSON-RPC `initialize` + `tools/call` HTTP requests to `/mcp`, and assert tool results/errors — covering at minimum: create+get task round trip, invalid transition rejection, tag validation, missing/invalid API key rejection.
- Existing REST integration tests continue to guard the extracted core functions; no regression risk from the refactor beyond what the full `cargo test` run already catches.

## Documentation

README gets a new section: MCP endpoint URL (`http://127.0.0.1:3000/mcp`), the `X-Api-Key` header requirement, and an example MCP client config block (Claude Code / opencode style) agents can copy.

## File-level breakdown (for the implementation plan)

- `backend/Cargo.toml` — add `rmcp`, `schemars` dependencies.
- `backend/src/handlers/tasks.rs`, `projects.rs`, `tags.rs` — extract core async functions reusable from both HTTP handlers and MCP tools.
- `backend/src/mcp.rs` — new: `TaskMcpServer`, tool definitions, param structs.
- `backend/src/lib.rs` — mount `/mcp` with auth middleware.
- `backend/tests/mcp.rs` — new integration tests.
- `README.md` — MCP section.
