# Post-Response AI Task Tracker Logging Design

## Goal

Record confirmed AI Task Tracker progress only after an OpenCode response has been delivered to the user. Replace the existing pre-response task-log nudge behavior with a local, durable delivery path that sends direct REST task-log requests asynchronously after `session.idle`.

This makes logging non-blocking for the response, preserves events through transient tracker outages and OpenCode restarts, and avoids duplicate direct logs when the agent has already called the MCP `add_task_log` tool.

## Non-goals

- Do not inject task-log nudges before a user-facing response or require the model to act on one before it can respond.
- Do not create tasks, change task status, modify tags, or alter tracker business rules.
- Do not replace MCP tools. Agent-authored logs through MCP remain supported and continue to be written by the tracker.
- Do not provide exactly-once delivery at the HTTP transport layer; the design provides at-least-once delivery with a stable idempotency key.
- Do not add a tracker-side queue, WebSocket dependency, or new REST endpoint.

## Architecture

The OpenCode task-tracker plugin owns four local components:

1. **Session event collector** — holds short-lived per-session context: the attached task, the response turn identifier, observed tracker MCP calls, and candidates for automatic progress logs.
2. **Post-response confirmer** — handles the OpenCode `session.idle` event. That event is the only trigger that converts candidates from the completed response turn into confirmed tracking events. It must run after the user-facing response has been emitted, never before it.
3. **Durable local queue** — persists each confirmed event before any delivery attempt. The queue survives plugin/process restart and is the source of truth for pending delivery.
4. **REST delivery worker** — drains due queue entries with an authenticated HTTP request, applies retry policy, and removes entries only after a terminal outcome.

The plugin communicates directly with the tracker REST API for these automatic logs:

```text
POST {AI_TRACKER_URL}/api/tasks/{taskId}/logs
X-Api-Key: {AI_TRACKER_API_KEY}
Content-Type: application/json
Idempotency-Key: {idempotencyKey}

{
  "author": "opencode",
  "message": "..."
}
```

`AI_TRACKER_URL` is normalized once at startup by removing a trailing slash, so the request path contains exactly one separator. The API key is supplied only as the `X-Api-Key` header; neither it nor complete request bodies are written to plugin logs.

## Data Model and Idempotency

Each queued event has the following logical shape. The concrete storage format may be SQLite or an atomically rewritten local file, provided it supplies the durability and uniqueness guarantees below.

```ts
type TrackingEvent = {
  idempotencyKey: string;
  sessionId: string;
  eventId: string;
  taskId: string;
  kind: "task-attached" | "response-progress";
  author: "opencode";
  message: string;
  createdAt: string;
  attempts: number;
  nextAttemptAt: string;
};
```

`idempotencyKey` is deterministically derived from the OpenCode session ID and an event ID unique within that session (for example, `opencode:{sessionId}:{eventId}`). Event IDs are allocated and persisted with the event, not regenerated on retry. The durable queue enforces uniqueness on `idempotencyKey`; repeated `session.idle` notifications and process recovery therefore cannot enqueue a second copy of the same event.

The REST request includes this value in `Idempotency-Key`. The tracker must treat repeated requests bearing the same key as the same log creation, returning a successful response without creating an additional row. This tracker-side idempotency contract is required because a process may crash after the server accepts a request but before the local queue records the success.

## Data Flow

### Normal post-response automatic logging

1. During a turn, the collector observes task context and prepares a candidate automatic progress event only when it has a concrete, user-facing result to report.
2. The plugin does not send an HTTP request and does not prompt the model while the response is being generated.
3. Once OpenCode emits `session.idle` for that response, the confirmer checks that the candidate belongs to the just-completed turn and has not already been confirmed.
4. The confirmer suppresses the candidate if that turn included an observed MCP `add_task_log` call for the same attached task. See [MCP duplicate suppression](#mcp-duplicate-suppression).
5. Otherwise, it assigns the session-scoped event ID, writes the confirmed event to durable storage, then signals the worker. A successful durable write is required before delivery begins.
6. The worker sends the REST request. On success (including a successful idempotent replay), it deletes the queue entry. It may deliver immediately in the idle handler or from a separately scheduled worker, but delivery must not delay or alter the response already shown to the user.

### `/tt` session attachment

**Final integration correction:** The local marker queues the verified attachment candidate after the user's explicit confirmation; it does not deliver it. `session.idle` is the delivery boundary, so no tracker HTTP request is made before idle.

`/tt <taskId>` first calls `get_task` to validate the requested task and asks the user for explicit confirmation. After confirmation, it calls `get_task` again and invokes the no-argument local plugin tool `task_tracker_mark_attachment_candidate`. The tool confirms only a same-turn, matching successful `get_task` result and queues the attachment candidate; it never calls tracker REST or MCP.

The marker queues one `task-attached` event with a stable event ID for that attachment operation. At the subsequent `session.idle`, the plugin signals its delivery worker; repeated idle events do not generate additional attachment logs. Changing the attachment later creates a new event for the new explicit `/tt` operation.

If the command fails, contains no valid task ID, the second `get_task` is malformed/failed/mismatched, or the marker is not invoked, no attachment event is queued. The marker's invocation can be visible in OpenCode tool transcripts.

### Startup and recovery

On plugin startup, the worker opens the local queue and schedules all due entries. It does not need active OpenCode sessions to retry them. Entries whose retry time is in the future remain durable until due. The queue is local to the machine and is not shared between OpenCode installations.

## MCP Duplicate Suppression

The collector observes completed MCP tool calls. A successful call to `add_task_log` records `{sessionId, turnId, taskId}` in the turn's in-memory observation set. It does not enqueue, mirror, or rewrite the MCP log.

At `session.idle`, an automatic `response-progress` candidate for the same session, turn, and task is suppressed when that observation exists. This prevents a direct REST log from duplicating an agent-authored MCP log. Observations are scoped to one response turn and cleared only after that turn is finalized, so an earlier MCP log does not suppress later automatic logs.

Only a completed/successful MCP result suppresses direct delivery. A failed, malformed, or unavailable MCP call is not evidence that the tracker received a log and therefore does not suppress an otherwise valid automatic event. `/tt` attachment logs are independent of MCP `add_task_log` observations and are not suppressed by them.

## Error Behavior

### Queue and confirmation failures

- If task context, the response turn, or an event candidate is incomplete, skip automatic logging for that candidate and record a diagnostic without blocking OpenCode.
- If queue initialization or durable enqueue fails, do not make the HTTP request. Keep the failure visible in local diagnostics, return a concise local marker-tool failure where applicable, and continue session context and lifecycle reminders without rejecting hooks.
- A malformed plugin event, missing task ID, or missing required configuration is a local permanent failure for that event. It must not crash the session or affect the user response.

### HTTP delivery classification

- **Success:** Any `2xx` response (including a server-confirmed idempotent replay) completes and removes the queue entry.
- **Retryable:** connection failures, DNS/TLS errors, timeouts, and HTTP `5xx` responses retain the entry and schedule a retry using bounded exponential backoff with jitter. `429` is also retryable; use `Retry-After` when present, otherwise use the same backoff schedule.
- **Permanent:** all other HTTP `4xx` responses are not retried. Record a sanitized diagnostic and mark the entry terminal (remove it from the active queue or retain it in a local failed/dead-letter record for operator inspection).
- **Unexpected responses:** an unreadable response body does not change status classification. Never log API keys, authorization headers, or full user response text in diagnostics.

Retries are independent per event. A failing task or unavailable tracker must not block later due events, `session.idle`, or user interaction.

## Required Configuration

The plugin requires the following environment/configuration values before automatic REST logging is enabled:

| Setting | Required | Purpose |
|---|---:|---|
| `AI_TRACKER_URL` | Yes | Base URL of the tracker REST service, without requiring a trailing slash. |
| `AI_TRACKER_API_KEY` | Yes | API key sent as `X-Api-Key` for each direct REST request. |
| `AI_TRACKER_QUEUE_PATH` | Yes | Machine-local durable queue location; the plugin process must be able to create, read, and atomically update it. |
| `AI_TRACKER_LOG_AUTHOR` | No | Author value for direct logs; defaults to `opencode`. |

Missing `AI_TRACKER_URL`, `AI_TRACKER_API_KEY`, or `AI_TRACKER_QUEUE_PATH` disables automatic direct logging with one clear startup diagnostic. It does not disable `/tt` attachment state or MCP tools. Queue paths must be excluded from source control and protected with filesystem permissions appropriate for data that can contain task IDs and log messages.

The tracker REST service must accept `POST /api/tasks/{taskId}/logs` with `X-Api-Key`, and must implement `Idempotency-Key` handling for this endpoint as described above. The OpenCode plugin configuration must load the post-response tracker plugin and expose the listed values to its process.

## Testing Plan

1. **Post-response ordering:** simulate a response turn and assert no HTTP call occurs before `session.idle`; progress candidates persist at idle, while a verified `/tt` marker may queue an attachment candidate before idle but still cannot trigger delivery until idle.
2. **Attachment behavior:** execute `/tt`, receive a successful matching `get_task`, invoke the local marker tool, and assert one `task-attached` candidate but no delivery before `session.idle`; repeat idle and restart/reload the queue to prove no duplicate. Assert malformed and failed `get_task` results enqueue nothing.
3. **MCP suppression:** for a turn with a successful observed `add_task_log` for the attached task, assert no automatic `response-progress` direct event. Verify failed MCP calls and MCP logs for another task do not suppress it.
4. **Idempotency and crash recovery:** assert duplicate confirmation attempts share one queue record and one `Idempotency-Key`; simulate a crash after server acceptance and verify replay uses the same key and produces no second tracker log.
5. **Retry policy:** verify network failure, timeout, `429`, and each `5xx` retry with scheduled backoff; verify every non-`429` `4xx` is terminal and is not retried.
6. **Queue durability:** restart the plugin with pending entries and verify due entries are delivered; verify an enqueue write failure produces no HTTP call.
7. **Configuration:** verify the plugin disables direct logging safely when each required setting is absent, does not expose secrets in diagnostics, and leaves MCP logging usable.

## Scope

Implementation is limited to the OpenCode task-tracker plugin, its tests, its configuration/documentation, and the tracker-side idempotency support needed by `POST /api/tasks/{taskId}/logs`. No source or configuration changes are made by this design document itself.

## Brainstorming Spec Self-Review

- **Placeholders:** Passed. Required values, event fields, endpoint, headers, trigger, and delivery classifications are explicitly defined; no unresolved implementation placeholders remain.
- **Consistency:** Passed. Every automatic log follows the same sequence—candidate, post-response `session.idle` confirmation, durable enqueue, then delivery—and every replay uses the same session/event-derived key.
- **Scope:** Passed. The design excludes pre-response nudges, tracker workflow changes, and replacement of MCP, while identifying the minimal tracker idempotency requirement for safe direct delivery.
- **Ambiguity:** Passed. `/tt` attachment timing, repeated idle behavior, successful-versus-failed MCP suppression, queue durability, retryability, and permanent `4xx` handling are specified. The only permitted implementation choices are internal queue technology and worker scheduling, both constrained by the stated guarantees.
