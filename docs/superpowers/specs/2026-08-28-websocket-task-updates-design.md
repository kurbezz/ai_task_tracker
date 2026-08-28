# WebSocket live task updates — design

## Goal
Push live task changes to connected browser clients so the UI (Board, Task detail,
Attention queue) updates automatically without manual refresh, whether the change
came from the web UI or from an AI agent via MCP.

## Decisions
- Cover all mutations: create, status transition, agent/result/title/description
  update, tag add/remove, log add, delete.
- Include MCP-triggered mutations (agents calling `create_task`,
  `transition_task_status`, `add_task_log`, etc.) — this is the primary use case.
- Broadcast is global to all connected clients; the frontend filters by
  `project_id` client-side. No per-project server-side subscription needed
  (single API key, internal tool).

## Architecture
Single Axum process already shared between REST API and MCP server, backed by
SQLite. Both paths already funnel through shared `*_core` functions in
`backend/src/handlers/tasks.rs`. Add an in-process `tokio::sync::broadcast`
channel to `AppState`, emit events from those same `*_core` functions (covers
web UI *and* MCP-driven changes with one set of edits), and expose a `/ws`
endpoint that streams events to browsers. No Redis/queue needed.

## Event contract (JSON over `/ws`)
```jsonc
{ "type": "task_created", "task": <TaskResponse> }
{ "type": "task_updated", "task": <TaskResponse> } // status change, tag add/remove, agent/result/title/description update
{ "type": "task_deleted", "task_id": "...", "project_id": "..." }
{ "type": "log_added", "task_id": "...", "log": <TaskLog> }
```
`TaskResponse`/`TaskLog` shapes already match the frontend's `Task`/`TaskLog`
types in `frontend/src/types.ts` — no new serialization work.

## Backend changes
- `AppState` (backend/src/lib.rs) gains `events: broadcast::Sender<TaskEvent>`
  (new `backend/src/events.rs` module defining `TaskEvent`, capacity ~256;
  lagging receivers just skip stale events — acceptable since WS is a refresh
  hint, not source of truth).
- Emit `state.events.send(...)` at the mutation exit points in
  `backend/src/handlers/tasks.rs`:
  - `create_task_core` → `task_created`
  - `update_task` (HTTP handler, title/description/agent/result_summary) → `task_updated`
  - `update_task_fields` (MCP agent/result_summary) → `task_updated`
  - `transition_task_core` → `task_updated`
  - `attach_tag_core` → `task_updated`
  - `remove_tag_core` → fetch task after removal, broadcast `task_updated`
  - `delete_task_core` → fetch task **before** delete (for `project_id`), broadcast `task_deleted` after delete succeeds
  - `create_log_core` → `log_added`
- New `GET /ws` route, top-level (not under `/api`, since browsers can't set
  the `X-Api-Key` header on a WS handshake). Auth via `?api_key=` query param,
  validated against the `api_keys` table (reuse `hash_key` from
  `backend/src/auth.rs`).
- Ensure axum's `ws` feature is enabled in `backend/Cargo.toml`.
- No deployment changes — same port, same `docker-compose.yml`.

## Frontend changes
- New `TaskEventsProvider` (React context), created once in `frontend/src/App.tsx`.
  Owns a single WebSocket to `wss://<host>/ws?api_key=<key>` (or `ws://` on
  non-TLS dev), auto-reconnects with backoff, and **refetches on reconnect**
  to cover events missed while disconnected.
- `BoardPage`: subscribe → upsert/remove tasks in local state by id.
- `TaskDetail`: subscribe filtered to its `taskId` → merge `task_updated`,
  append `log_added`, close panel on `task_deleted`.
- `AttentionPage`: subscribe → refetch on any event (small dataset; tag
  membership needs recomputation anyway).
- `frontend/vite.config.ts`: add `/ws` proxy with `ws: true` for dev.
- No visual connection indicator — feature is invisible plumbing; initial
  fetch-based load stays as-is, WS is purely additive.

## Testing
- Backend: `cargo test` — add an integration test that hits `create_task` /
  `transition_task` through the router while holding a `broadcast::Receiver`
  and asserts the expected event arrives (pattern mirrors the existing MCP
  session test in `backend/src/lib.rs`).
- Frontend: no test runner configured in this repo. Verify with
  `npm run build` (tsc type-check) plus manual check in dev server (two
  browser tabs, confirm live sync).
