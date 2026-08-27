# AI Task Tracker — Design

## Purpose

Personal, self-hosted task tracker for managing tasks executed by AI agents (LLM-based coding agents / orchestrators). Single user. Tasks move through a fixed planning→implementation→review→deploy pipeline that mirrors how AI-assisted engineering work actually happens, and agents can flag tasks that need human attention.

## Users & Access

- Single user (owner), running the tool locally / self-hosted.
- AI agents interact with the tracker exclusively through the REST API using an API key (`X-Api-Key` header).
- The owner interacts through the web UI (and may also call the API directly).
- No multi-tenant auth, no user accounts/roles — one API key is sufficient for v1. The `api_keys` table exists so keys can be rotated/revoked without a schema change.

## Architecture

- **Backend**: Rust, Axum web framework, `sqlx` for SQLite access, migrations via `sqlx migrate`.
- **Frontend**: React + TypeScript + Vite SPA.
- **Packaging**: Single binary. The backend embeds the built frontend assets (via `rust-embed` or equivalent) and serves both `/api/*` and the static SPA from one process (`cargo run` / one binary to deploy). In development, Vite's dev server proxies `/api/*` to the Axum backend.
- **Storage**: SQLite file on disk (e.g. `data/tracker.db`).

Rationale: a single Rust binary keeps the "personal, local, no external dependencies" property the user asked for, while still getting a proper SPA UI (React/Vite) rather than being limited to server-rendered templates.

## Data Model

### `projects`
| column | type | notes |
|---|---|---|
| id | uuid (text) | PK |
| name | text | required |
| description | text | nullable |
| created_at | timestamp | |

### `tasks`
| column | type | notes |
|---|---|---|
| id | uuid (text) | PK |
| project_id | uuid | FK → projects.id |
| title | text | required |
| description | text | nullable |
| status | text (enum) | see Status Workflow |
| agent | text | nullable — which agent/model is/was working the task |
| result_summary | text | nullable — final outcome summary |
| created_at | timestamp | |
| updated_at | timestamp | |

### `task_logs`
Append-only timeline per task. Covers agent progress updates, results, and system-generated entries (status transitions).

| column | type | notes |
|---|---|---|
| id | uuid (text) | PK |
| task_id | uuid | FK → tasks.id |
| author | text | e.g. agent name, "system", "user" |
| message | text | required |
| created_at | timestamp | |

### `tags`
| column | type | notes |
|---|---|---|
| id | uuid (text) | PK |
| name | text | unique |
| is_system | bool | true for predefined tags (see below) |

Predefined system tags (seeded on first run):
- `NEEDS_USER_INPUT` — agent needs a decision/input from the owner.
- `BLOCKED` — task blocked by an external factor.
- `FAILED` — agent attempt failed; task stays at its current pipeline status, tag + a `task_logs` entry record the failure reason. There is no separate `FAILED` pipeline status.

Custom freeform tags may also be created.

### `task_tags`
Many-to-many join: `task_id`, `tag_id`.

### `api_keys`
| column | type | notes |
|---|---|---|
| id | uuid (text) | PK |
| key_hash | text | hashed key value |
| label | text | human-readable label |
| created_at | timestamp | |

## Status Workflow

Fixed, linear pipeline. Transitions are validated server-side; invalid transitions return `409 Conflict`.

```
TODO → IN_PLANNING → READY_TO_IMPLEMENT → IN_WORK → WAIT_REVIEW → READY_TO_DEPLOY → DONE
```

- `TODO`: not started.
- `IN_PLANNING`: questions being clarified, spec/plan being written.
- `READY_TO_IMPLEMENT`: plan written, ready for implementation to start.
- `IN_WORK`: implementation in progress.
- `WAIT_REVIEW`: implementation done, awaiting review.
- `READY_TO_DEPLOY`: review passed, ready to ship.
- `DONE`: complete.

Failure/blockage does **not** introduce a new pipeline status — it is represented by applying the `FAILED` or `BLOCKED` tag plus a `task_logs` entry explaining why, while the task remains at its current status (typically the status is manually moved backward by the owner/agent if rework is needed, or moves forward when the issue is resolved and tags are cleared).

## API

All routes under `/api/*` require a valid `X-Api-Key` header.

- `GET /api/projects` / `POST /api/projects`
- `GET /api/projects/:id` / `PATCH /api/projects/:id` / `DELETE /api/projects/:id`
- `GET /api/projects/:id/tasks` — list tasks in a project
- `POST /api/tasks` — create task (project_id in body)
- `GET /api/tasks/:id` / `PATCH /api/tasks/:id` — update title/description/agent/result_summary
- `POST /api/tasks/:id/status` — request a status transition; validated against the allowed pipeline order, `409` on invalid transition
- `GET /api/tasks/:id/logs` / `POST /api/tasks/:id/logs` — append/read timeline entries
- `POST /api/tasks/:id/tags` / `DELETE /api/tasks/:id/tags/:tag_id`
- `GET /api/tags` — list all tags (system + custom)

Errors return a consistent JSON shape: `{ "error": "message", "code": "SOME_CODE" }`.

## UI

- **Project list / sidebar**: switch between projects.
- **Board view** (per project): kanban columns, one per pipeline status. Cards show title, `agent`, and tag badges (`NEEDS_USER_INPUT` visually distinct/highlighted).
- **Task detail panel**: description, status control (manual transition, respecting allowed pipeline order), agent, tags, full log timeline.
- **"Needs attention" view**: cross-project list of all tasks currently tagged `NEEDS_USER_INPUT` (and optionally `BLOCKED`/`FAILED`) — the owner's daily triage view.

## Error Handling

- Backend validates all status transitions against the fixed pipeline order; anything else is rejected with `409` and a clear error code.
- Standard JSON error envelope for all API error responses.
- Frontend surfaces API errors via toast notifications; forms show inline validation errors for required fields (title, project).

## Testing

- **Backend**: integration tests against an in-memory SQLite database — API key auth (valid/invalid/missing key), status transition validation (valid path succeeds, skipping/reversing without cause is rejected), tag CRUD, log append/read.
- **Frontend**: manual QA is sufficient for v1 given this is a personal tool; no dedicated component test suite required at this stage.

## Out of Scope (v1)

- Multi-user accounts, roles, permissions.
- Task dependencies / sub-task graphs.
- Token/cost/time-spent metrics.
- Notifications (email/push) for `NEEDS_USER_INPUT`.
