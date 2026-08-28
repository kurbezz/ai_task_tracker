# source_url / pr_url task fields — design

## Goal
Let a task carry a link to its originating item (e.g. YouTrack/Sentry issue)
and a link to its Pull Request, as separate optional fields.

## Decisions
- Two new optional string fields: `source_url`, `pr_url`. Plain text URLs, no
  format validation.
- Editable via both the web UI (task detail panel) and MCP (`create_task`,
  `update_task` tools) — same access level as `agent`/`result_summary`.
- Settable at task creation time too (both optional), not just via later update.
- Not shown on the kanban board card — details panel only.

## Backend changes (`backend/`)
- New migration `migrations/0003_add_source_pr_urls.sql`:
  ```sql
  ALTER TABLE tasks ADD COLUMN source_url TEXT;
  ALTER TABLE tasks ADD COLUMN pr_url TEXT;
  ```
- `src/models.rs`:
  - `Task`: add `pub source_url: Option<String>, pub pr_url: Option<String>`.
  - `TaskResponse`: add the same two fields; wire them in `TaskResponse::new`.
  - `CreateTask`: add `pub source_url: Option<String>, pub pr_url: Option<String>`
    (both optional, `schemars::JsonSchema` derive already present on the struct).
  - `UpdateTask`: add `#[serde(default)] pub source_url: PatchField<String>` and
    same for `pr_url`, matching the existing `description` field's pattern.
- `src/handlers/tasks.rs`:
  - `create_task_core`: include `source_url`/`pr_url` in the constructed `Task`
    and the `INSERT` statement/bindings.
  - `update_task` (HTTP handler): resolve `source_url`/`pr_url` via
    `PatchField::resolve` like `description`, include in the `UPDATE` statement.
  - `update_task_fields` (used by the MCP `update_task` tool): extend its
    parameters to accept `source_url: Option<String>, pr_url: Option<String>`
    (in addition to the existing `agent`/`result_summary`), same
    "provided value replaces, absent keeps current" semantics used there today
    (note: this function currently uses `Option::or`, not `PatchField`, for
    agent/result_summary — follow the same convention for consistency within
    this function, i.e. `Option<String>` where `None` means unchanged).
  - Every other `SELECT ... FROM tasks` that hydrates a `Task` via
    `sqlx::query_as::<_, Task>` must also select the two new columns:
    `fetch_task`, `list_project_tasks_core`, `transition_task_core`'s inner
    select, and `list_attention`'s `AttentionTask` struct/query.
- `src/mcp.rs`: extend `UpdateTaskParams` with
  `source_url: Option<String>, pr_url: Option<String>`, pass through to
  `update_task_fields`. The `create_task` MCP tool needs no change — it
  already forwards the full `CreateTask` struct.
- No changes needed to the WebSocket broadcast layer — the new fields ride
  along inside the existing `TaskResponse` payload already sent on
  `task_created`/`task_updated` events.

## Frontend changes (`frontend/`)
- `src/types.ts`: add `source_url: string | null; pr_url: string | null;` to
  the `Task` interface.
- `src/api.ts`: extend `createTask`'s input object type and `updateTask`'s
  `Partial<Pick<Task, ...>>` type to include `source_url` and `pr_url`.
- `src/pages/BoardPage.tsx`: add two new optional inputs to the new-task form
  ("Source link", "PR link"), styled/positioned like the existing optional
  `Agent` field, included in the `createTask` payload only when non-empty
  (`...(sourceUrl.trim() && { source_url: sourceUrl })`, same pattern as
  `agent`/`description` today).
- `src/components/TaskDetail.tsx`: add `sourceUrl`/`prUrl` state, initialized
  in `refresh()` and in the `useTaskEvents` `task_updated` handler (same
  pattern as `agent`/`result`). Add two inputs to the existing
  "Assignment & outcome" edit form (same `saveDetails` submit action, same
  `.trim() || null` handling as `agent`/`result_summary`). Below each input,
  when the current task has a non-empty value for that field, render a small
  external link: `<a href={task.source_url} target="_blank" rel="noreferrer">Open ↗</a>`
  (and same for `pr_url`). No changes to the kanban card component.

## Testing
- Backend: extend/add to existing `cargo test` coverage — at minimum, one
  test asserting a task created with `source_url`/`pr_url` round-trips them
  through `GET /tasks/:id`, and one asserting `PATCH /tasks/:id` can set,
  update, and clear (`null`) them. Run full `cargo test` to confirm no
  regressions from the new columns in existing queries.
- Frontend: `npm run build` (tsc type-check) must pass; no test runner
  configured in this repo.
