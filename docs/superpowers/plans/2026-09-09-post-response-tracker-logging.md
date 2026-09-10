# Post-Response AI Task Tracker Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not commit any changes; the parent policy requires explicit user authorization before commits.

**Goal:** Record automatic AI Task Tracker progress only after the OpenCode response is complete, using a durable local queue and direct authenticated REST delivery, while preserving MCP-authored logs and non-log lifecycle reminders.

**Architecture:** The tracker accepts a stable `Idempotency-Key` on its existing task-log POST endpoint and stores the key-to-log mapping transactionally. The OpenCode plugin collects turn-scoped facts in memory, confirms an attachment or progress candidate only from `session.idle`, durably writes the confirmed event to an atomically rewritten JSON queue, and then schedules a non-blocking REST worker. The queue retries independently and preserves the original idempotency key across restarts. Existing reminder injection remains only for task/status lifecycle cues; it never asks the model to add a task log.

**Tech Stack:** Rust 2021, Axum 0.8, SQLx/SQLite, TypeScript, OpenCode's Bun runtime with Node-compatible `node:fs/promises`, Vitest, native `fetch`/`AbortSignal`.

---

## Fixed implementation decisions

1. **Tracker storage:** add a separate SQLite idempotency table rather than changing `task_logs`. Existing MCP and REST clients may omit the header and continue creating a new row per request.
2. **Plugin runtime typing:** add `@types/node` and set `types: ["node"]` in `opencode-plugin/tsconfig.json`. Use `process.env` and `node:fs/promises`, which OpenCode's Bun runtime supports and Vitest can execute; do not introduce Bun-only globals or a second runtime type definition.
3. **Queue format:** use one queue file at `AI_TRACKER_QUEUE_PATH`, atomically replaced with a same-directory temporary file. Its versioned JSON envelope contains active events and terminal dead-letter records. A per-process promise mutex serializes every read-modify-write operation, and `idempotencyKey` is unique among both active and completed enqueue attempts.
4. **Turn identity:** use `chat.message`'s `messageID` as the response-turn identity when it is supplied. When OpenCode omits it, allocate a session-local monotonic `turn-N` value. Associate all tool events with the currently active turn, finalize each turn at most once, and clear its tool/MCP observations only after its `session.idle` handling completes. Never correlate a candidate with an arbitrary later idle event by session ID alone.
5. **`/tt` confirmation boundary:** the installed plugin API exposes `command.execute.before({ command, sessionID, arguments })` but no command-after/result hook. Mark a syntactically valid `/tt` invocation as provisional in the before hook. After the user confirms, `/tt` must call `get_task` again, and the no-argument `task_tracker_mark_attachment_candidate` ToolDefinition confirms only a same-turn matching successful result. The marker queues a local candidate without tracker REST/MCP calls; it may be visible in tool transcripts, and delivery is deferred until `session.idle`. Invalid/empty arguments, malformed/failed validation, or no marker invocation never create an attachment event.
6. **Automatic progress scope:** create one `response-progress` candidate only from a completed, parseable successful `transition_task_status` result for the attached task. Its message is `Updated task {taskId} status to {status}.` Do not invent a log from edits, shell commands, malformed output, or raw assistant text, because the plugin API does not expose a safely session-attributable final assistant response body.

## File structure

- `backend/migrations/0005_add_task_log_idempotency.sql` (new, lines 1-8) — key-to-log mapping with a primary-key uniqueness constraint.
- `backend/src/handlers/tasks.rs:1-18,335-377` — read `Idempotency-Key`, return the original log on replay, and serialize first-write/replay races.
- `backend/tests/logs_and_tags.rs:1-107` — endpoint idempotency, replay, and concurrent-request regression tests.
- `opencode-plugin/package.json:1-15`, `opencode-plugin/package-lock.json`, `opencode-plugin/tsconfig.json:1-12` — Node runtime types used by queue/config code.
- `opencode-plugin/src/config.ts` and `opencode-plugin/src/config.test.ts` (new, lines 1-120) — strict environment parsing, URL normalization, and safe startup diagnostics.
- `opencode-plugin/src/queue.ts` and `opencode-plugin/src/queue.test.ts` (new, lines 1-260) — durable JSON queue, atomic persistence, uniqueness, and dead letters.
- `opencode-plugin/src/delivery.ts` and `opencode-plugin/src/delivery.test.ts` (new, lines 1-300) — direct REST request construction, retry classification, scheduling, and replay behavior.
- `opencode-plugin/src/state.ts:1-45`, `opencode-plugin/src/state.test.ts:1-31` — active response turns, attachment operations, candidates, and finalized-turn bookkeeping.
- `opencode-plugin/src/turns.ts` and `opencode-plugin/src/turns.test.ts` (new, lines 1-260) — pure turn collection and `session.idle` confirmation rules.
- `opencode-plugin/src/tool-events.ts:1-78`, `opencode-plugin/src/tool-events.test.ts:1-79` — attach completed tool results and successful `add_task_log` observations to the correct turn.
- `opencode-plugin/src/reminders.ts:1-46`, `opencode-plugin/src/reminders.test.ts:1-61` — retain lifecycle prompts but remove all task-log prompt language.
- `opencode-plugin/ai-task-tracker-nudge.ts:1-100`, `opencode-plugin/ai-task-tracker-nudge.test.ts:1-230` — load configuration/queue/worker, register the local attachment marker, preserve all tool-after events, and stage delivery only after idle.
- `.opencode/opencode.json:3-42`, `.gitignore:1-4`, and `README.md:6-90` — plugin environment names, queue-file exclusion, and operational setup.

---

## Task 1: Make tracker-side task-log creation idempotent

**Files:**
- Create: `backend/migrations/0005_add_task_log_idempotency.sql:1-8`
- Modify: `backend/src/handlers/tasks.rs:1-18,335-377`
- Modify: `backend/tests/logs_and_tags.rs:1-107`

- [ ] **Step 1: Add failing endpoint tests for first creation, replay, and a race.**

  Add a request helper that accepts an optional idempotency key, then append tests with this contract:

  ```rust
  let first = app.clone().oneshot(support::api_request_with_headers(
      Method::POST,
      &format!("/api/tasks/{task_id}/logs"),
      Some(json!({"author": "opencode", "message": "Updated task"})),
      [("idempotency-key", "opencode:session-1:response-progress:message-1")],
  )).await.unwrap();
  assert_eq!(first.status(), StatusCode::CREATED);
  let created = support::json_body(first).await;

  let replay = app.clone().oneshot(support::api_request_with_headers(
      Method::POST,
      &format!("/api/tasks/{task_id}/logs"),
      Some(json!({"author": "opencode", "message": "Updated task"})),
      [("idempotency-key", "opencode:session-1:response-progress:message-1")],
  )).await.unwrap();
  assert_eq!(replay.status(), StatusCode::OK);
  assert_eq!(support::json_body(replay).await["id"], created["id"]);
  ```

  In a separate test, submit two independently built requests with the identical key via `tokio::join!`, assert that their statuses are one `201 Created` and one `200 OK`, assert both response IDs match, then `GET /api/tasks/{task_id}/logs` and assert exactly one row. Add a no-header assertion that two otherwise identical posts remain two `201` responses with different IDs.

- [ ] **Step 2: Run the focused tests and verify RED.**

  ```bash
  cargo test --manifest-path backend/Cargo.toml --test logs_and_tags idempotency -- --nocapture
  ```

  Expected: FAIL because the helper/schema/handler do not yet recognize `Idempotency-Key`, so replay creates a second log.

- [ ] **Step 3: Add the additive migration.**

  Create `backend/migrations/0005_add_task_log_idempotency.sql` with:

  ```sql
  CREATE TABLE task_log_idempotency (
    idempotency_key TEXT PRIMARY KEY NOT NULL,
    task_log_id TEXT NOT NULL UNIQUE REFERENCES task_logs(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );
  ```

  Do not edit `backend/migrations/0001_initial.sql:22-28`: deployed databases must receive the new table through the numbered migration, while fresh databases receive both migrations.

- [ ] **Step 4: Implement header-aware, race-safe creation.**

  In `backend/src/handlers/tasks.rs:1-18`, import `HeaderMap` and extract the optional `idempotency-key` in `create_log`. Reject an empty or non-UTF-8 supplied key with `AppError::BadRequest("invalid Idempotency-Key header".to_owned())`; absence remains valid.

  Keep `create_log_core` for MCP callers and header-less requests. Add a sibling idempotent core path used only when a key is present. It must:

  1. acquire one pool connection and execute `BEGIN IMMEDIATE`;
  2. select `task_log_idempotency.task_log_id` by key and, if present, select and return that stored `TaskLog` without inserting or broadcasting;
  3. otherwise perform the existing task existence and log validation, insert the `task_logs` row, insert its key mapping, and `COMMIT` before broadcasting exactly one `TaskEvent::LogAdded`;
  4. roll back on every error.

  Return `(StatusCode::CREATED, Json(log))` for an inserted mapping and `(StatusCode::OK, Json(log))` for a replay. The immediate SQLite write transaction is required: a select-then-insert without it permits two concurrent request handlers to create two log rows before one loses a uniqueness race. Do not send the event for the replay path, and do not change the existing authentication middleware or endpoint registration at `backend/src/lib.rs:94-102`.

- [ ] **Step 5: Verify GREEN and preserve existing logs/tags behavior.**

  ```bash
  cargo test --manifest-path backend/Cargo.toml --test logs_and_tags idempotency -- --nocapture
  cargo test --manifest-path backend/Cargo.toml --test logs_and_tags creates_lists_and_validates_task_logs -- --exact
  ```

  Expected: idempotent first/replay/race tests pass; the existing header-less task-log test still passes with two distinct rows.

---

## Task 2: Add typed plugin configuration without exposing secrets

**Files:**
- Modify: `opencode-plugin/package.json:6-14`, `opencode-plugin/package-lock.json`
- Modify: `opencode-plugin/tsconfig.json:2-10`
- Create: `opencode-plugin/src/config.ts:1-118`
- Create: `opencode-plugin/src/config.test.ts:1-125`

- [ ] **Step 1: Write configuration tests first.**

  Test the pure parser with explicit records rather than mutating the process environment:

  ```ts
  expect(readTrackerConfig({
    AI_TRACKER_URL: "https://tracker.example/",
    AI_TRACKER_API_KEY: "secret-key",
    AI_TRACKER_QUEUE_PATH: "/tmp/tracker-queue.json",
  })).toEqual({
    enabled: true,
    baseUrl: "https://tracker.example",
    apiKey: "secret-key",
    queuePath: "/tmp/tracker-queue.json",
    author: "opencode",
  });

  expect(readTrackerConfig({ AI_TRACKER_API_KEY: "secret-key" })).toEqual({
    enabled: false,
    diagnostic: "AI Task Tracker automatic logging disabled: AI_TRACKER_URL, AI_TRACKER_QUEUE_PATH are required.",
  });
  ```

  Add cases for each individual missing required value, an empty/whitespace URL, a non-HTTP(S) URL, repeated trailing slashes, and an explicit `AI_TRACKER_LOG_AUTHOR`. Assert diagnostics contain configuration variable names only and never contain the supplied API key.

- [ ] **Step 2: Run the new test and verify RED.**

  ```bash
  npm test --prefix opencode-plugin -- src/config.test.ts
  ```

  Expected: FAIL because `src/config.ts` does not exist.

- [ ] **Step 3: Select the common Node-compatible runtime surface and implement parsing.**

  Add `"@types/node": "^24.12.2"` to `devDependencies`, regenerate `opencode-plugin/package-lock.json`, and replace `"types": []` with `"types": ["node"]`. In `src/config.ts`, export `TrackerConfig`, `DisabledTrackerConfig`, and `readTrackerConfig(env: NodeJS.ProcessEnv = process.env)`.

  The enabled configuration must trim inputs, normalize the parsed HTTP(S) URL with `url.toString().replace(/\/+$/, "")`, reject an empty normalized URL, preserve the API key only in memory, require a non-empty queue path, and default the trimmed author to `opencode`. Return the exact deterministic disabled diagnostic shown in the test, listing all absent settings in this order: `AI_TRACKER_URL`, `AI_TRACKER_API_KEY`, `AI_TRACKER_QUEUE_PATH`.

  The entry point will emit that one diagnostic once at startup. It must not print `apiKey`, request headers, raw queue events, or full messages.

- [ ] **Step 4: Verify GREEN and typecheck.**

  ```bash
  npm test --prefix opencode-plugin -- src/config.test.ts
  npm run typecheck --prefix opencode-plugin
  ```

  Expected: all configuration cases pass and TypeScript recognizes `process`, `node:fs/promises`, and `NodeJS.ProcessEnv` without Bun-specific declarations.

---

## Task 3: Implement the durable queue before delivery

**Files:**
- Create: `opencode-plugin/src/queue.ts:1-258`
- Create: `opencode-plugin/src/queue.test.ts:1-286`

- [ ] **Step 1: Define queue durability tests before creating the module.**

  Use a unique `mkdtemp` directory per test and an injected filesystem adapter that can fail `writeFile`. Start with this event fixture:

  ```ts
  const event: TrackingEvent = {
    idempotencyKey: "opencode:s-1:response-progress:m-1",
    sessionId: "s-1",
    eventId: "response-progress:m-1",
    taskId: "task-1",
    kind: "response-progress",
    author: "opencode",
    message: "Updated task task-1 status to TO_REVIEW.",
    createdAt: "2026-09-09T12:00:00.000Z",
    attempts: 0,
    nextAttemptAt: "2026-09-09T12:00:00.000Z",
  };
  ```

  Test the following concrete outcomes:

  ```ts
  const queue = await openTrackingQueue(path);
  await queue.enqueue(event);
  await queue.enqueue(event);
  expect((await queue.dueAt("2026-09-09T12:00:00.000Z"))).toEqual([event]);
  expect((await openTrackingQueue(path)).dueAt("2026-09-09T12:00:00.000Z"))
    .resolves.toEqual([event]);
  ```

  Also assert that an interrupted pre-rename `*.tmp` file does not replace the last valid queue, that a failed enqueue write rejects and leaves no event visible to a reopened queue, that `markRetry` changes only that event, and that `markTerminal` removes it from active events while retaining a sanitized dead-letter record.

- [ ] **Step 2: Run the queue suite and verify RED.**

  ```bash
  npm test --prefix opencode-plugin -- src/queue.test.ts
  ```

  Expected: FAIL because `src/queue.ts` and `TrackingEvent` do not exist.

- [ ] **Step 3: Implement the versioned atomic queue.**

  In `src/queue.ts`, export the exact `TrackingEvent` shape from the approved design plus:

  ```ts
  type QueueFile = {
    version: 1;
    events: TrackingEvent[];
    deadLetters: Array<TrackingEvent & { failedAt: string; reason: string }>;
  };
  ```

  `openTrackingQueue(path)` must create the parent directory with mode `0o700`, initialize a new file with mode `0o600`, reject malformed/non-version-1 queue JSON with a sanitized error, and serialize every mutation through one promise mutex. For each mutation, read the latest committed envelope, apply the operation, write JSON to `${path}.${process.pid}.${crypto.randomUUID()}.tmp` using mode `0o600`, call `FileHandle.sync()`, rename it over `path`, and sync the parent directory. Ignore stale temporary files on open; only the canonical queue path is authoritative.

  `enqueue` returns `false` when the key already exists and `true` only after an atomic committed write. It must compare `idempotencyKey`, not a message or task ID. `removeDelivered`, `markRetry`, and `markTerminal` identify records by the same key. No HTTP function belongs in this module.

- [ ] **Step 4: Verify GREEN.**

  ```bash
  npm test --prefix opencode-plugin -- src/queue.test.ts
  ```

  Expected: duplicate enqueue leaves one event, restart reloads it, failed writes make no event deliverable, and active/dead-letter transitions persist across reopen.

---

## Task 4: Build direct REST delivery and independent retries

**Files:**
- Create: `opencode-plugin/src/delivery.ts:1-298`
- Create: `opencode-plugin/src/delivery.test.ts:1-335`

- [ ] **Step 1: Write delivery tests with injected clock, fetch, timer, and random source.**

  Assert the exact request contract:

  ```ts
  await worker.deliver(event);
  expect(fetchMock).toHaveBeenCalledWith(
    "https://tracker.example/api/tasks/task-1/logs",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        "X-Api-Key": "secret-key",
        "Content-Type": "application/json",
        "Idempotency-Key": "opencode:s-1:response-progress:m-1",
      }),
      body: JSON.stringify({ author: "opencode", message: "Updated task task-1 status to TO_REVIEW." }),
    }),
  );
  ```

  Add cases for `201`, `200`, and every other `2xx` removing the record; a thrown network error, abort timeout, every `500` through `599`, and `429` retaining it with a retry; `429` with `Retry-After: 17` scheduling exactly 17 seconds later; and `400`, `401`, `403`, `404`, and `422` becoming terminal with no second attempt. Inject `random: () => 0.5` and a fixed clock so the ordinary retry delays are exactly `1s`, `2s`, `4s`, then capped at `300s`.

  Include a crash-recovery test: make the first mock server acceptance retain the queue entry by forcing `removeDelivered` to throw, reopen the queue, deliver again, and assert both requests use the identical `Idempotency-Key` while the fake server's set of created-log keys has size one.

- [ ] **Step 2: Run the focused suite and verify RED.**

  ```bash
  npm test --prefix opencode-plugin -- src/delivery.test.ts
  ```

  Expected: FAIL because the worker module does not exist.

- [ ] **Step 3: Implement transport and worker behavior.**

  `src/delivery.ts` must use `fetch` with `AbortSignal.timeout(10_000)` and construct exactly:

  ```text
  POST {baseUrl}/api/tasks/{encodeURIComponent(taskId)}/logs
  X-Api-Key: {apiKey}
  Content-Type: application/json
  Idempotency-Key: {event.idempotencyKey}
  {"author": event.author, "message": event.message}
  ```

  Classify any `2xx` as delivered; connection/DNS/TLS/timeout errors, `429`, and `5xx` as retryable; every other `4xx` as terminal. Parse `Retry-After` as delta-seconds first, then HTTP-date; if neither is usable, apply `min(300_000, 1_000 * 2 ** (attempts - 1)) * (0.5 + random())`. Increment and persist `attempts` and `nextAttemptAt` before scheduling the next attempt. Never include the API key, headers, full request body, or full response body in diagnostics.

  `TrackingDeliveryWorker.start()` opens the queue and schedules all due entries immediately without requiring an active OpenCode session. Keep an `inFlight` key set so a timer and `session.idle` signal cannot concurrently send the same queue entry. Schedule later due events individually; one retryable failure must not block a different due event. `signal()` may queue a microtask to drain, but the idle hook must not await network delivery.

- [ ] **Step 4: Verify GREEN.**

  ```bash
  npm test --prefix opencode-plugin -- src/delivery.test.ts
  ```

  Expected: the request uses one normalized slash and the required headers, success/replay removes entries, retries honor fixed backoff/`Retry-After`, permanent failures are terminal, and replay reuses one stable key.

---

## Task 5: Add turn-scoped collection, `/tt` marking, and explicit confirmation

**Attachment correction:** The before hook records only provisional `/tt` intent. After explicit user confirmation, `/tt` runs `get_task` again; the custom no-argument marker queues the attachment only for a matching successful result. It is not an idle-only automatic attachment confirmer and it never sends tracker HTTP/MCP requests. Delivery is staged for `session.idle`.

**Files:**
- Modify: `opencode-plugin/src/state.ts:3-45`
- Modify: `opencode-plugin/src/state.test.ts:1-31`
- Create: `opencode-plugin/src/turns.ts:1-258`
- Create: `opencode-plugin/src/turns.test.ts:1-314`

- [ ] **Step 1: Write pure lifecycle tests.**

  Cover the boundary explicitly rather than testing it through a live OpenCode process:

  ```ts
  beginResponseTurn(state, { messageID: "message-7" });
  recordProgressCandidate(state, {
    taskId: "task-1",
    status: "TO_REVIEW",
  });
  expect(state.activeTurn?.progressCandidate).toMatchObject({ taskId: "task-1" });
  expect(fakeQueue.events).toEqual([]);

  const confirmed = confirmIdle(state, "2026-09-09T12:00:00.000Z");
  expect(confirmed[0]).toMatchObject({
    eventId: "response-progress:message-7",
    idempotencyKey: "opencode:session-1:response-progress:message-7",
    kind: "response-progress",
  });
  expect(confirmIdle(state, "2026-09-09T12:01:00.000Z")).toEqual([]);
  ```

  The actual test must call confirmation only once before the first expectation; the first two lines above express the intended pre-idle state: no enqueue or delivery signal occurs before idle. Add assertions for (a) a missing `messageID` creating `turn-1`, then `turn-2`, (b) a later turn never consuming the earlier turn's candidate, (c) a failed queue enqueue returning no delivery signal and leaving the turn eligible only for a repeated idle notification, and (d) queue reopen plus duplicate idle still producing one persisted key.

  Add attachment cases using the exact installed hook input shape:

  ```ts
  markTtBefore(state, { command: "tt", sessionID: "session-1", arguments: "task-9" });
  const [attachment] = confirmIdle(state, "2026-09-09T12:00:00.000Z");
  expect(attachment).toMatchObject({
    eventId: "task-attached:attachment-1",
    taskId: "task-9",
    kind: "task-attached",
    message: "Attached this OpenCode session to task task-9.",
  });
  ```

  Assert whitespace-only and multi-token `/tt` arguments produce no attachment, a second explicit `/tt task-9` has `attachment-2` and a different key, and an attachment is not suppressed by an MCP log observation.

- [ ] **Step 2: Run the turn suite and verify RED.**

  ```bash
  npm test --prefix opencode-plugin -- src/state.test.ts src/turns.test.ts
  ```

  Expected: FAIL because the turn/attachment types and lifecycle helpers do not exist.

- [ ] **Step 3: Extend session state and implement the confirmer.**

  Add to `SessionState` an active turn, a monotonic fallback-turn counter, a monotonic attachment-operation counter, and a `finalizedTurnIds` set. An active turn contains its `id`, a snapshot of the attached task for any progress candidate, at most one progress candidate, successful MCP log task IDs, and attachment candidates. `beginResponseTurn` must replace only a finalized/no-active turn; if an active turn is unexpectedly replaced before idle, discard its unconfirmed candidates with a sanitized diagnostic rather than attaching them to the new response.

  `markTtBefore` must accept only `command.toLowerCase() === "tt"` and an `arguments.trim()` value matching exactly one non-whitespace task ID token. It assigns `attachment-N`, associates it with the active turn (creating an explicit fallback turn when necessary), and updates `state.taskId` only as provisional attachment state. At idle, a valid turn confirms one `task-attached` event per unconfirmed attachment operation; repeated idle sees the finalized ID and emits none. This gives an explicit same-task reattachment a distinct operation/key while avoiding duplicate idle logs.

  `confirmIdle` turns an attachment into:

  ```ts
  {
    idempotencyKey: `opencode:${sessionId}:task-attached:${operationId}`,
    eventId: `task-attached:${operationId}`,
    kind: "task-attached",
    author,
    message: `Attached this OpenCode session to task ${taskId}.`,
  }
  ```

  It turns the sole unsuppressed status candidate into `eventId: "response-progress:{turnId}"` and the corresponding `opencode:{sessionId}:response-progress:{turnId}` key. Allocate these values once before calling `queue.enqueue`; never regenerate them for a repeated idle or retry. Write to the queue first, and call `worker.signal()` only when `enqueue` reports a committed insert. A queue error logs a sanitized diagnostic, leaves the active turn unfinalized, and makes no HTTP call.

- [ ] **Step 4: Verify GREEN.**

  ```bash
  npm test --prefix opencode-plugin -- src/state.test.ts src/turns.test.ts
  ```

  Expected: no pre-idle events, repeated idle is idempotent, fallback IDs are session-local and ordered, valid `/tt` produces exactly one deferred attachment log, and a failed queue write never signals delivery.

---

## Task 6: Bind completed tool results to the correct turn and suppress duplicate MCP logs

**Files:**
- Modify: `opencode-plugin/src/tool-events.ts:1-78`
- Modify: `opencode-plugin/src/tool-events.test.ts:1-79`
- Modify: `opencode-plugin/src/turns.ts:1-258`, `opencode-plugin/src/turns.test.ts:1-314`

- [ ] **Step 1: Add failing tool/turn integration tests.**

  Add an event containing the active turn identity, then assert a parseable successful status transition creates the candidate only for the attached task:

  ```ts
  applyToolExecuteAfter(state, {
    tool: "mcp_Ai-task-tracker_transition_task_status",
    args: { task_id: "task-1", status: "TO_REVIEW" },
    outputText: JSON.stringify({ id: "task-1", status: "TO_REVIEW" }),
  });
  expect(state.activeTurn?.progressCandidate).toEqual({
    taskId: "task-1",
    status: "TO_REVIEW",
    message: "Updated task task-1 status to TO_REVIEW.",
  });
  ```

  For the same active turn, feed a completed `add_task_log` output shaped as a `TaskLog` for `task-1`, finalize idle, and assert no `response-progress` event was enqueued. Add counterexamples where the MCP output is malformed/an error, the log's task differs, or the successful log is in an earlier finalized turn; each must leave the current turn's progress event intact. Assert the same successful MCP observation does not suppress a `/tt` attachment event.

- [ ] **Step 2: Run the affected tests and verify RED.**

  ```bash
  npm test --prefix opencode-plugin -- src/tool-events.test.ts src/turns.test.ts
  ```

  Expected: FAIL because `applyToolExecuteAfter` currently updates status directly from arguments and has no turn/MCP-success bookkeeping.

- [ ] **Step 3: Make success detection strict and turn-scoped.**

  Preserve the existing non-log command and plan/spec flags in `applyToolExecuteAfter`. For tracker transitions, parse the completed output and require a matching string `id` plus a valid `status`; do not create a candidate from request arguments alone. Record it only if that ID equals the task attached when the candidate is captured, so later `/tt` changes cannot retarget it.

  For `add_task_log`, require a completed output object containing non-empty `id`, `task_id`, `author`, `message`, and `created_at`, and require `task_id` to equal the active turn's candidate task. Record only that task ID in the active turn's successful-MCP set. Do not enqueue, mirror, or modify the MCP-created log. `confirmIdle` suppresses only `response-progress` when that exact active turn/task observation exists, never an attachment event. Clear observations after the successful finalization of that turn; a failed enqueue must retain them for repeated idle processing.

- [ ] **Step 4: Verify GREEN.**

  ```bash
  npm test --prefix opencode-plugin -- src/tool-events.test.ts src/turns.test.ts
  ```

  Expected: only completed successful same-turn/same-task MCP logs suppress direct progress; failed, malformed, different-task, and prior-turn calls do not.

---

## Task 7: Wire OpenCode hooks and remove pre-response log nudges

**Final attachment integration correction:** Register the installed no-argument `ToolDefinition` named `task_tracker_mark_attachment_candidate`. It calls `tracker.confirmPendingAttachment(context.sessionID, config.author)`, returns concise plain text, and no-ops unless a same-turn matching `get_task` result verified the pending `/tt` candidate. It does not call tracker REST or MCP; the local queue candidate is staged for delivery only at `session.idle`. Queue initialization and confirmation failures are caught locally so session-ID context and all lifecycle reminders still stage. The marker may be visible in tool transcripts. Keep `tool.execute.after` processing every existing tool event, retain the create-task lifecycle reminder, and keep the to-review text free of `add_task_log`.

**Files:**
- Modify: `opencode-plugin/ai-task-tracker-nudge.ts:1-47`
- Modify: `opencode-plugin/src/reminders.ts:9-46`
- Modify: `opencode-plugin/src/reminders.test.ts:1-61`

- [ ] **Step 1: Write reminder and hook-wiring tests.**

  Change the existing `to-review` reminder expectation to the exact non-log text:

  ```ts
  expect(evaluateReminder(state)?.text).toBe(
    "A commit was made on this task. Consider transition_task_status to TO_REVIEW.",
  );
  ```

  Add a source-level entry-point test that instantiates the exported plugin with injected `readTrackerConfig`, queue, and worker fakes and verifies: `command.execute.before` with `tt` calls `markTtBefore`; `chat.message` starts a turn with its `messageID`; `event` with `session.idle` awaits only durable confirmation and then calls `worker.signal`; and a deferred `fetch` promise cannot delay event completion after enqueue. Assert `experimental.chat.system.transform` still injects the session-ID context and lifecycle reminder, but neither `"add_task_log"` nor `"AI Task Tracker reminder"` contains a task-log instruction.

- [ ] **Step 2: Run the focused plugin tests and verify RED.**

  ```bash
  npm test --prefix opencode-plugin -- src/reminders.test.ts ai-task-tracker-nudge.test.ts
  ```

  Expected: FAIL because the entry point has no command-before/chat-message/queue wiring and the existing reminder text still asks for `add_task_log`.

- [ ] **Step 3: Replace the nudge-only idle path with post-response confirmation.**

  Update the plugin factory to parse configuration once. When disabled, emit its single sanitized startup diagnostic and return hooks that retain session state, `/tt` marking, MCP observation, and non-log reminders but do not create a queue or issue REST requests. When enabled, open the queue and start the worker during plugin initialization; startup must schedule recovery delivery without an OpenCode session.

  Register these installed hooks exactly:

  - `"chat.message"` — call `beginResponseTurn(store.get(input.sessionID), { messageID: input.messageID })`.
  - `"command.execute.before"` — call `markTtBefore` with `{ command: input.command, sessionID: input.sessionID, arguments: input.arguments }`.
  - `"tool.execute.after"` — retain the current `applyToolExecuteAfter` call, now associated with `store.get(input.sessionID)`'s active turn.
  - `event` — for only `session.idle`, obtain `properties.sessionID`, call the confirmer, await queue persistence, and use `void worker.signal()` after successful enqueue; then evaluate only the retained non-log lifecycle reminder rules.
  - `"experimental.chat.system.transform"` — retain the session-ID injection and one-shot lifecycle reminder injection; it must not create a tracking candidate, enqueue an event, or invoke REST delivery.

  Add `dispose` to clear worker timers. Remove the `add_task_log` clause from the `to-review` reminder. Keep `create-task`, `to-agent`, `to-deploy`, and `done` lifecycle cues and their existing state-reset behavior; these are status/task workflow prompts, not logging prompts.

- [ ] **Step 4: Verify GREEN.**

  ```bash
  npm test --prefix opencode-plugin -- src/reminders.test.ts ai-task-tracker-nudge.test.ts
  npm run typecheck --prefix opencode-plugin
  ```

  Expected: `/tt` is marked through the supported before hook, durable confirmation occurs only at idle, delivery is asynchronous after persistence, and no injected reminder asks the model to log progress.

---

## Task 8: Document configuration and keep queue data out of source control

**Files:**
- Modify: `.opencode/opencode.json:36-42`
- Modify: `.gitignore:1-4`
- Modify: `README.md:6-39,55-90`

- [ ] **Step 1: Add configuration/documentation checks first.**

  Add a documentation test or repository check that asserts `.opencode/opencode.json` references `{env:AI_TRACKER_API_KEY}` (not `AI_TRACKER_API_TOKEN`), `.gitignore` contains `*.ai-task-tracker-queue.json`, and README documents all four exact variables. The README code block must be:

  ```bash
  export AI_TRACKER_URL="http://127.0.0.1:3000"
  export AI_TRACKER_API_KEY="replace-with-your-key"
  export AI_TRACKER_QUEUE_PATH="$HOME/.local/state/opencode/ai-task-tracker-queue.json"
  export AI_TRACKER_LOG_AUTHOR="opencode" # optional; this is the default
  ```

- [ ] **Step 2: Run the check and verify RED.**

  ```bash
  node --input-type=module -e 'import { readFileSync } from "node:fs"; const c = readFileSync(".opencode/opencode.json", "utf8"); const r = readFileSync("README.md", "utf8"); const g = readFileSync(".gitignore", "utf8"); if (!c.includes("{env:AI_TRACKER_API_KEY}") || !r.includes("AI_TRACKER_QUEUE_PATH") || !g.includes("*.ai-task-tracker-queue.json")) process.exit(1)'
  ```

  Expected: FAIL until all three files are updated.

- [ ] **Step 3: Update operational configuration.**

  In `.opencode/opencode.json:36-42`, change only the tracker MCP header interpolation from `{env:AI_TRACKER_API_TOKEN}` to `{env:AI_TRACKER_API_KEY}` so MCP and direct REST use the same inherited secret. Do not put any actual API key or queue path in tracked JSON.

  Add `*.ai-task-tracker-queue.json` to root `.gitignore`. In README, add a **Post-response OpenCode logging** section after the MCP section that includes the exact export block, explains that OpenCode must be restarted after changing inherited environment values, says the URL is normalized for one `/api` separator, and states the queue contains task IDs/messages, must live outside the repository, is created with owner-only permissions, survives restart, and is retried asynchronously. Document that missing URL/key/path disables only automatic direct logs; `/tt` session state and MCP tools remain usable. State that keys are sent only in `X-Api-Key` and must never be logged.

- [ ] **Step 4: Verify GREEN.**

  ```bash
  node --input-type=module -e 'import { readFileSync } from "node:fs"; const c = readFileSync(".opencode/opencode.json", "utf8"); const r = readFileSync("README.md", "utf8"); const g = readFileSync(".gitignore", "utf8"); if (!c.includes("{env:AI_TRACKER_API_KEY}") || !r.includes("AI_TRACKER_URL") || !r.includes("AI_TRACKER_API_KEY") || !r.includes("AI_TRACKER_QUEUE_PATH") || !r.includes("AI_TRACKER_LOG_AUTHOR") || !g.includes("*.ai-task-tracker-queue.json")) process.exit(1)'
  ```

  Expected: zero exit status; tracked files contain no concrete API key or machine-local queue path.

---

## Task 9: Parent-orchestrator final validation

**Validation owner:** Parent orchestrator. The implementation worker must not run these unassigned broad checks automatically.

**Files:** verification only.

- [ ] **Step 1: Format and test the backend migration and handler.**

  ```bash
  cargo fmt --manifest-path backend/Cargo.toml --check
  cargo test --manifest-path backend/Cargo.toml --test logs_and_tags
  ```

  Expected: formatting has no diff; first/replay/race idempotency tests and existing logs/tags tests pass.

- [ ] **Step 2: Test and typecheck the plugin.**

  ```bash
  npm test --prefix opencode-plugin
  npm run typecheck --prefix opencode-plugin
  ```

  Expected: configuration, queue durability, REST/retry/crash-replay, turn identity, `/tt`, MCP suppression, lifecycle-reminder, and existing matcher tests pass; TypeScript has no errors.

- [ ] **Step 3: Run the post-response smoke test against a local tracker.**

  Start the backend with a disposable SQLite database and an API key, launch OpenCode with the four documented environment values, attach `/tt <known-task-id>`, and produce a response. Before the response reaches `session.idle`, assert no `POST /api/tasks/{id}/logs` occurs. At idle, assert one `task-attached` POST with `author: "opencode"` and an `Idempotency-Key` beginning `opencode:{sessionId}:task-attached:`. Trigger the same idle notification again and restart OpenCode with a queued retry; assert no duplicate tracker row and that the replay sends the unchanged key. In a later response turn, make a successful MCP `add_task_log` for the attached task and assert no automatic `response-progress` POST; make a failed MCP call and assert the automatic progress POST remains eligible.

  Expected: all automatic writes happen after response completion, queue recovery is at-least-once but tracker rows are idempotent, and MCP-authored logs are not duplicated.

- [ ] **Step 4: Review implementation scope without committing.**

  ```bash
  git diff --check
  git diff -- backend/migrations/0005_add_task_log_idempotency.sql backend/src/handlers/tasks.rs backend/tests/logs_and_tags.rs opencode-plugin .opencode/opencode.json .gitignore README.md docs/superpowers/plans/2026-09-09-post-response-tracker-logging.md
  ```

  Expected: no whitespace errors; changes are limited to tracker idempotency, post-response plugin delivery, tests, config/docs, and this plan. Do not stage, commit, amend, or push.

## Plan self-review

- **Spec coverage:** backend schema/handler idempotency, replay and race preservation are Task 1; typed environment/runtime selection is Task 2; queue durability and recovery are Task 3; direct REST/retry behavior is Task 4; state, response-turn identity, `/tt`, idle confirmation, and MCP suppression are Tasks 5-7; nudge removal with non-log lifecycle cues preserved is Task 7; docs/config and final validation are Tasks 8-9.
- **Ordering:** every automatic event follows candidate → `session.idle` confirmation → durable enqueue → asynchronous delivery. No pre-response HTTP request or task-log prompt is introduced.
- **No placeholders:** queue technology, atomic write protocol, IDs, endpoint, headers, retry constants, test inputs, failure classification, and validation commands are fixed. No commit steps appear.
