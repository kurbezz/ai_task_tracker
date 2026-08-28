# Quick time logging from the task detail panel — design

## Goal
Let a user log hours against a task directly from its detail panel, without
navigating to the separate Time Tracking screen, and see/edit/delete all
time previously logged for that task.

## Decisions
- Quick-add: hours input + "Add" button, always logs against **today**
  (no date picker in this form — past-day logging stays on the Time
  Tracking page).
- Below the quick-add form, show a list of **all** time entries logged for
  this task across all dates (date + hours), each editable (hours) and
  deletable — mirrors the Time Tracking page's row interaction exactly.
- No date filter, no per-task sync button here — sync stays a Time
  Tracking page action (syncing is per-day across tasks, not per-task).

## Backend changes (`backend/`)
- `backend/src/handlers/time_entries.rs`:
  - Add `pub entry_date: String` to `TimeEntryResponse`, included in all
    three existing `SELECT` queries that hydrate it (`list_entries_for_date`,
    `fetch_entry`) — add `time_entries.entry_date` to the column list. This
    is additive and doesn't break the existing by-date list/sync flow.
  - Extend `ListTimeEntriesQuery` to accept an optional `task_id` alongside
    the existing optional... actually `date` is currently required — change
    it to `Option<String>` and add `task_id: Option<String>`. Validate that
    at least one of `date`/`task_id` is present (400 if neither).
  - `list_time_entries` handler: if `task_id` is present, return all entries
    for that task ordered by `entry_date DESC, created_at DESC` (no `sync`
    status — the response's `sync` field becomes `Option<SyncStatus>`,
    `None` for the task_id path since sync status is date-scoped, not
    task-scoped). If `date` is present (existing behavior), keep returning
    the per-date entries + `sync` status as today.
  - No changes to `create_time_entry`/`update_time_entry`/`delete_time_entry`
    — already generic per-entry endpoints, reused as-is.
- Add a test: `GET /api/time-entries?task_id=X` returns entries for that
  task across multiple dates, correctly excludes other tasks' entries, and
  `sync` is absent/null in the response. Keep existing date-based tests
  passing (response shape for that path is unchanged except the additive
  `entry_date` field).

## Frontend changes (`frontend/`)
- Extract `todayLocal()` and `formatHours()` from
  `frontend/src/pages/TimeTrackingPage.tsx` into a small shared module
  (e.g. `frontend/src/timeFormat.ts`), used by both `TimeTrackingPage.tsx`
  and the new code in `TaskDetail.tsx` — avoid duplicating this logic.
- `frontend/src/types.ts`: add `entry_date: string` to `TimeEntry`. Add a
  variant response type for the task_id list call (`sync` absent) or just
  type it as `{ entries: TimeEntry[] }` since the caller won't touch `sync`.
- `frontend/src/api.ts`: add `listTaskTimeEntries(taskId)` →
  `GET /time-entries?task_id=...` → `{ entries: TimeEntry[] }`.
- `frontend/src/components/TaskDetail.tsx`: new "Time logged" section
  (placed after the existing "Tags" section, before "Timeline" — or
  wherever reads best alongside the existing section order), containing:
  - Quick-add row: hours input (decimal, same `step="0.25"` convention as
    the Time Tracking page) + "Add" button. On submit, converts hours →
    minutes and calls `createTimeEntry({ task_id: taskId, entry_date:
    todayLocal(), minutes })`, prepends/appends to local list.
  - List of this task's entries (date + hours), each with inline edit
    (click hours to edit, Save/Cancel — same pattern as
    `TimeTrackingPage.tsx`'s row editor) and a delete button. Fetch this
    list on mount (and re-fetch on `taskId` change, alongside the existing
    `refresh()` call) via `listTaskTimeEntries(taskId)`.
  - Empty state when no entries exist yet for this task.
  - No sync UI here (per decision above).

## Testing
- Backend: `cargo test` — new task_id-filter test plus full suite passing.
- Frontend: `npm run build` passes; manual check that adding time from a
  task's detail panel makes it show up (a) in that task's own list and
  (b) on the Time Tracking page for today's date.
