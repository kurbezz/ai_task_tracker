# opencode Integration: Nudge Plugin + Skill — Design

## Goal

Make opencode-based coding agents (Claude Code / opencode running against this repo and other `work/*` projects) use the AI Task Tracker MCP server more actively — without turning the tracker into something the agent has to remember on its own, and without giving any new component network access to the tracker.

## Non-goals

- The plugin never calls the tracker's REST or MCP endpoints itself. It never creates, transitions, logs, or tags anything. All actual tracker writes still go through the model calling the already-connected `ai-task-tracker` MCP tools.
- No new backend/API changes. This is purely an opencode-side (client) integration.
- No cross-session/persistent state. Reminder state is in-memory per opencode process/session only.

## Current workflow (source of truth)

As of commit `3b5d596` ("simplify status workflow to 5 stages", already on `origin/master`), the canonical status pipeline is:

```
TO_DO → TO_AGENT → TO_REVIEW → TO_DEPLOY → DONE
```

Note: the MCP server this design was scoped against was, at time of writing, still serving the older 7-stage enum (`TODO, IN_PLANNING, READY_TO_IMPLEMENT, IN_WORK, WAIT_REVIEW, READY_TO_DEPLOY, DONE`) — a stale deploy. This design targets the current 5-stage model in the repo; the deployed server is expected to catch up via the existing CI → Dokploy webhook once redeployed (a force-push of rewritten commit authorship on `master` was performed separately and should also trigger this).

## Architecture

Two new artifacts, both living inside the `ai_task_tracker` repo, wired into the shared `work` opencode config (`~/.agents-configs/opencode/work/opencode.json`):

1. **Plugin** — `opencode-plugin/ai-task-tracker-nudge.ts` (repo root). Referenced explicitly in the shared config's `plugin` array via a `file://` path, since `.opencode` inside this repo is a symlink to the shared config directory and therefore not scanned for auto-discovery.
2. **Skill** — `skills/ai-task-tracker/SKILL.md` added to the shared config's existing `skills/` folder (sibling of `skills/sentry-triage/`).

Both are consumed by any opencode session that loads the shared `work` config — i.e. this repo and any other project under `~/work` that symlinks `.opencode` to it.

## Plugin behavior

All state is in-memory, keyed by session id, and discarded when the process exits. No file writes, no network calls.

### Per-session state shape

```ts
type SessionState = {
  taskId: string | null;
  status: "TO_DO" | "TO_AGENT" | "TO_REVIEW" | "TO_DEPLOY" | "DONE" | null;
  hadMutatingToolCall: boolean;   // edit/write/non-readonly bash seen this session
  sawPlanOrSpecContext: boolean;  // executing-plans skill used, or docs/**/specs|plans/*.md touched
  didCommitSinceLastReminder: boolean;
  didPushOrOpenPr: boolean;
  deployMentioned: boolean;
  remindedFor: Set<Status>;       // one reminder per transition per session
};
```

### Hooks used

- **`tool.execute.after`** — inspected for every tool call:
  - `mcp_Ai-task-tracker_create_task` / `get_task` results → parse JSON result, cache `{taskId, status}`. Malformed/unexpected JSON is caught and ignored (never throws, never blocks the underlying call).
  - `mcp_Ai-task-tracker_transition_task_status` calls → update cached `status` directly from the call's `args.status` (cheaper and more reliable than re-parsing a response).
  - `bash` tool calls → regex match the command string:
    - `git commit` → `didCommitSinceLastReminder = true`
    - `git push` or `gh pr create` (or similar MR-creation commands) → `didPushOrOpenPr = true`
  - `edit` / `write` / non-read-only `bash` calls → `hadMutatingToolCall = true`.
  - Any tool call that reads/writes a path matching `docs/**/specs/*.md` or `docs/**/plans/*.md`, or a `task` call whose prompt references the `executing-plans` skill → `sawPlanOrSpecContext = true`.
- **`chat.message`** — lightweight keyword scan of the latest message text for deploy-confirmation language (`deployed`, `released`, `задеплоили`, `выкатили`, `в проде`, PR/MR link patterns like `github.com/.../pull/`). Sets `deployMentioned` / `didPushOrOpenPr` accordingly. This is a heuristic, not proof — false negatives are acceptable (worst case: a missed reminder, never a wrong write, since the plugin never writes).
- **`event`** — on session-idle, evaluate cached state against the following rules, in order, firing **at most one new reminder per idle event** (first rule below that hasn't already been reminded for this session, based on `remindedFor`):
  1. No `taskId` yet **and** `hadMutatingToolCall` → nudge: "this session has made changes but has no linked AI Task Tracker task — consider `create_task` (or confirm none is needed)."
  2. `status === "TO_DO"` **and** `sawPlanOrSpecContext` → nudge: "spec/plan context detected — consider `transition_task_status` → `TO_AGENT` before starting implementation."
  3. `status === "TO_AGENT"` **and** `didCommitSinceLastReminder` → nudge: "a commit was made — consider `add_task_log` with a summary and `transition_task_status` → `TO_REVIEW`."
  4. `status === "TO_REVIEW"` **and** `didPushOrOpenPr` → nudge: "a push/PR was detected — consider `transition_task_status` → `TO_DEPLOY`."
  5. `status === "TO_DEPLOY"` **and** `deployMentioned` → nudge: "deployment was mentioned — consider `transition_task_status` → `DONE`."
  - After a rule fires, its status is added to `remindedFor` so it never repeats in the same session, even if the idle event fires again with the same state.

### Reminder delivery mechanism

The reminder is injected as a nudge visible only to the model (not rendered to the user as a normal chat message) — implemented via the plugin's `chat.message` (or `experimental.chat.system.transform`, whichever proves to be the correct injection point) hook, adding a system-scoped content block ahead of the next model turn. Exact hook choice is an implementation detail to confirm against the actual opencode plugin API during implementation (see Open Questions).

## Skill content (`skills/ai-task-tracker/SKILL.md`)

Frontmatter description front-loads trigger terms: "AI Task Tracker", "self-report progress", "NEEDS_USER_INPUT", "BLOCKED", "FAILED", so it surfaces whenever an agent is deciding how to report status.

Body covers:
- The 5-stage status pipeline (`TO_DO → TO_AGENT → TO_REVIEW → TO_DEPLOY → DONE`), one-step-forward-or-any-rework transition rule.
- Tag meanings: `NEEDS_USER_INPUT` (blocked on a decision from the owner), `BLOCKED` (external blocker), `FAILED` (attempt failed, tag + log, no separate pipeline status), plus freeform custom tags.
- `task_logs` conventions: `author` should identify the acting agent/model, `message` should be a concrete progress/result statement, not a restatement of the tool call.
- Explicit instruction: before starting non-trivial changes in a session with no linked task, create one via `create_task` (or confirm to the user that no task is needed for trivial work).
- A short worked example: create → log progress → transition → tag `NEEDS_USER_INPUT` when blocked → resolve → transition onward.

## Error handling / edge cases

- Malformed or unexpected MCP tool JSON result → caught, state update skipped, tool call itself unaffected.
- Session touches multiple tasks/projects → state tracks only the most recently touched task; reminders reference that one only.
- In-memory state resets on process restart — acceptable, since the tracker itself (via `get_task`/`list_project_tasks`) remains the single source of truth; the plugin is a soft nudge layer, never authoritative.
- No possibility of the plugin writing wrong/stale data to the tracker, because it never writes at all.

## Testing

- Manual scratch-session walkthrough inside this repo: edit a file → `git commit` → mention a PR link → confirm each expected reminder appears once at the corresponding idle checkpoint, and does not repeat.
- Unit tests for the pure matcher functions (git-command regexes, deploy-keyword scan, plan/spec path matcher) using `vitest` (already available via the frontend's Vite tooling) — these are the only genuinely unit-testable pieces since the rest is hook wiring against the live opencode process.
- Config change verification: after implementation, update the shared `work/opencode.json` plugin array entry to the new in-repo path, and confirm (per `customize-opencode` skill guidance) that a full opencode restart is required for it to take effect — config is not hot-reloaded.

## File-level breakdown (for the implementation plan)

- `opencode-plugin/ai-task-tracker-nudge.ts` — new: plugin implementation (state tracking, hook wiring, reminder text).
- `opencode-plugin/ai-task-tracker-nudge.test.ts` (or similar) — new: unit tests for pure matcher functions.
- `~/.agents-configs/opencode/work/opencode.json` — edit: replace the currently-broken plugin path with `file:///Users/kurbezz/work/ai_task_tracker/opencode-plugin/ai-task-tracker-nudge.ts`.
- `~/.agents-configs/opencode/work/skills/ai-task-tracker/SKILL.md` — new: the skill described above.

## Open Questions (to resolve during implementation)

- Exact opencode plugin hook/API for injecting a model-only (not user-visible) reminder — confirm via `@opencode-ai/plugin` types/docs before writing the reminder-delivery code path.
- Exact shape of `tool.execute.after`'s `output` for MCP tool calls (field names for result JSON, args) — confirm against actual runtime behavior or plugin API types, not just this repo's Rust source, since the two can drift (as already observed with the status enum).
