# Manual time tracking → Clockify — design

## Goal
Let the user manually log time spent per task, per day, in a dedicated
screen, and push a single combined daily entry to Clockify.

## Decisions
- Dedicated "Time tracking" screen (not per-task inline entry).
- One Clockify time entry per day (not per task) — description lists the
  tasks/durations that make it up.
- Date is selectable (defaults to today), so past days can be logged too.
- Rows are editable/deletable after entry, before or after syncing.
- User enters durations in **hours** (decimal, e.g. `1.5`) in the UI; stored
  internally as integer minutes (`round(hours * 60)`), converted back to
  hours for display. The wire API (backend REST contract) operates in
  minutes — the hours↔minutes conversion is a frontend-only concern.
- No Clockify account exists yet — credentials come from env vars and the
  feature must work fully (local logging) even when unconfigured; only the
  "Sync to Clockify" action requires configuration.

## Local data model (source of truth — Clockify entry is a derived mirror)
New migration `backend/migrations/0004_add_time_entries.sql`:
```sql
CREATE TABLE time_entries (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  entry_date TEXT NOT NULL,   -- 'YYYY-MM-DD'
  minutes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE daily_time_syncs (
  entry_date TEXT PRIMARY KEY NOT NULL,
  clockify_entry_id TEXT,
  synced_at TEXT
);
```

## Sync semantics (per date)
1. Recompute `total_minutes = SUM(minutes)` over all `time_entries` rows for
   that `entry_date`.
2. Anchor `start = "{entry_date}T00:00:00Z"`, `end = start + total_minutes`
   (a virtual range whose only purpose is to carry the total duration —
   wall-clock accuracy doesn't matter here).
3. `description` = list built from that date's rows, e.g.
   `"Task A (1.5h), Task B (0.5h)"`.
4. If `daily_time_syncs.clockify_entry_id` already exists for the date →
   `PUT https://api.clockify.me/api/v1/workspaces/{workspaceId}/time-entries/{id}`
   with the recomputed `start`/`end`/`description` (full idempotent
   overwrite — correcting one row and re-syncing fixes the whole entry, no
   incremental math needed).
5. Else → `POST .../workspaces/{workspaceId}/time-entries`, store the
   returned `id` into `daily_time_syncs.clockify_entry_id`, set `synced_at`.
6. Auth header: `X-Api-Key: <CLOCKIFY_API_KEY>`. All timestamps ISO 8601 UTC.
7. If all rows for an already-synced date are deleted, do **not**
   auto-delete the Clockify entry (MVP scope; user removes it manually in
   Clockify if needed).

## Backend changes (`backend/`)
- `src/clockify.rs`: small `reqwest`-based client with `create_time_entry`
  and `update_time_entry` functions matching the request/response shapes
  above. Config struct loaded from env:
  `CLOCKIFY_API_KEY`, `CLOCKIFY_WORKSPACE_ID`, optional `CLOCKIFY_PROJECT_ID`
  (sent as `projectId` if set), optional `CLOCKIFY_BASE_URL` (defaults to
  `https://api.clockify.me/api/v1`, overridable for tests against a local
  mock server). `AppState` gets `pub clockify: Option<ClockifyConfig>` — `None`
  when required env vars are absent.
- `src/handlers/time_entries.rs`:
  - `GET /api/time-entries?date=YYYY-MM-DD` → rows for that date (id,
    task_id, task title via join to `tasks`, minutes) plus sync status
    (`synced_at`, whether `clockify_entry_id` is set).
  - `POST /api/time-entries` → body `{ task_id, entry_date, minutes }`,
    creates a row.
  - `PATCH /api/time-entries/:id` → body `{ minutes?, task_id? }`, edits a row.
  - `DELETE /api/time-entries/:id` → removes a row.
  - `POST /api/time-entries/sync` → body `{ entry_date }`; runs the sync
    semantics above. Returns `400`/a clear error message if
    `state.clockify` is `None` ("Clockify is not configured"), or if the
    Clockify API call itself fails (propagate its status/message).
- Promote `reqwest` from `[dev-dependencies]` to `[dependencies]` in
  `backend/Cargo.toml` (keep `rustls-tls` + `json` features; dev-dependency
  entry can be removed if now redundant, or left if tests need distinct
  features — check for conflicts).
- Mount the new routes under the existing authenticated `/api` router in
  `backend/src/lib.rs`, same `auth::require_api_key` middleware as other
  `/api/*` routes.
- Tests: CRUD round-trip for `time_entries` against the local DB; a unit
  test for the pure "build Clockify request body from a list of rows"
  logic (no network); an integration test for the sync endpoint using
  `CLOCKIFY_BASE_URL` pointed at a local mock HTTP server (e.g. `wiremock`,
  add as a dev-dependency if not already present) to verify POST-then-PUT
  behavior without hitting the real Clockify API.

## Frontend changes (`frontend/`)
New standalone page, not a mechanical extension of an existing pattern —
route this piece to @designer:
- New route `/time` ("Time tracking"), nav link added in `App.tsx`.
- Date picker (defaults to today).
- Add-row form: task picker + hours input (decimal, e.g. step `0.25`),
  submit appends a row for the selected date (calls `POST /api/time-entries`
  after converting hours → minutes).
- Row list for the selected date: task title, hours (editable inline,
  `PATCH` on save), delete button (`DELETE`).
- Sync status area: last synced time / "not synced yet", and a
  "Sync to Clockify" button (`POST /api/time-entries/sync`) that shows
  success/error feedback. If the backend reports Clockify isn't configured,
  show that state clearly (button disabled or a helper note) rather than a
  raw error.
- `types.ts`: add `TimeEntry` (`id`, `task_id`, `task_title`, `minutes`) and
  a sync-status type (`synced_at: string | null`, `clockify_entry_id: string | null`).
- `api.ts`: add `listTimeEntries(date)`, `createTimeEntry(...)`,
  `updateTimeEntry(id, ...)`, `deleteTimeEntry(id)`, `syncTimeEntries(date)`.

## Testing
- Backend: `cargo test` — CRUD tests, the pure request-building unit test,
  and the mock-server sync integration test, all passing alongside the
  existing suite.
- Frontend: `npm run build` (tsc type-check) passes; no test runner
  configured in this repo, manual check in dev server.
