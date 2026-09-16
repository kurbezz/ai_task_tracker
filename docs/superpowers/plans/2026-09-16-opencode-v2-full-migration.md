# OpenCode V2 Full Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the shared OpenCode profile and AI Task Tracker nudge plugin on the V2 configuration and plugin contracts while retaining `/tt` and tracker delivery behavior.

**Architecture:** OpenCode is already installed as `v2.0.4`; first preserve the current shared configuration and dirty plugin worktree, then convert only active configuration shapes. Port the plugin as a thin V2 adapter around the existing state, turn, delivery, and tool-output modules: V2 prompt/context/tool/event APIs feed the existing tracker without inventing turns during model-context construction.

**Tech Stack:** OpenCode 2.0.4, `@opencode/plugin`, TypeScript, Vitest, JSON/JSONC, npm.

---

## File map

| Path | Responsibility |
| --- | --- |
| `~/.config/opencode/opencode.json` | Global V2 configuration; retains Slim and Chrome DevTools. |
| `~/.agents-configs/opencode/work/opencode.json` | Shared work-profile configuration reached via the repository `.opencode` symlink. |
| `~/.agents-configs/opencode/home/opencode.json` | Shared home-profile configuration. |
| `~/.config/opencode/command/tt.md` | Legacy command source to copy into V2 command discovery and update for the typed marker tool. |
| `~/.config/opencode/commands/tt.md` | Native V2 global `/tt` command. |
| `opencode-plugin/package.json` and `opencode-plugin/package-lock.json` | V2 Plugin SDK and reproducible lockfile. |
| `opencode-plugin/ai-task-tracker-nudge.ts` | V2 plugin entrypoint and adapters. |
| `opencode-plugin/ai-task-tracker-nudge.test.ts` | Entrypoint and end-to-end adapter contract tests. |
| `opencode-plugin/src/{state,turns,tool-events,tool-output}.ts` | Existing state/delivery semantics; modify only when a V2 event shape requires a narrow adapter. |

### Task 1: Preserve the migration baseline and verify the installed CLI

**Files:**
- Create: `~/.config/opencode/backups/v2-$stamp/`, where `$stamp` is `date -u +%Y%m%dT%H%M%SZ`
- Create: `~/.agents-configs/opencode/backups/v2-$stamp/`, where `$stamp` is `date -u +%Y%m%dT%H%M%SZ`
- Modify: none
- Test: command output and checksums recorded in the two backup directories

- [ ] **Step 1: Capture versions, paths, and the exact pre-migration diffs.**

  Run:

  ```bash
  cd /Users/kurbezz/work/ai_task_tracker
  {
    date -u +'%Y-%m-%dT%H:%M:%SZ'
    command -v opencode
    opencode --version
    command -v opencode2 || true
    opencode2 --version || true
    git status --short
    git diff -- opencode-plugin/ai-task-tracker-nudge.ts opencode-plugin/ai-task-tracker-nudge.test.ts opencode-plugin/src/state.ts opencode-plugin/src/tool-events.ts opencode-plugin/src/turns.ts
    git ls-files --others --exclude-standard opencode-plugin
  } > /private/var/folders/y9/9xxmd1b12zz5t670sgtkhcs40000gn/T/opencode-v2-migration-baseline.txt
  ```

- [ ] **Step 2: Create unique, access-restricted backups without overwriting `opencode.json.bak`.**

  Run:

  ```bash
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  global_backup="$HOME/.config/opencode/backups/v2-$stamp"
  shared_backup="$HOME/.agents-configs/opencode/backups/v2-$stamp"
  mkdir -p "$global_backup" "$shared_backup"
  chmod 700 "$global_backup" "$shared_backup"
  cp -p "$HOME/.config/opencode/opencode.json" "$global_backup/opencode.json"
  cp -p "$HOME/.config/opencode/command/tt.md" "$global_backup/tt.md"
  cp -p "$HOME/.agents-configs/opencode/work/opencode.json" "$shared_backup/work-opencode.json"
  cp -p "$HOME/.agents-configs/opencode/home/opencode.json" "$shared_backup/home-opencode.json"
  shasum -a 256 "$global_backup"/* "$shared_backup"/* > "$shared_backup/SHA256"
  ```

- [ ] **Step 3: Verify the baseline.**

  Run:

  ```bash
  test "$(opencode --version)" = "opencode v2.0.4"
  cmp -s "$HOME/.config/opencode/opencode.json" "$global_backup/opencode.json"
  cmp -s "$HOME/.agents-configs/opencode/work/opencode.json" "$shared_backup/work-opencode.json"
  cmp -s "$HOME/.agents-configs/opencode/home/opencode.json" "$shared_backup/home-opencode.json"
  shasum -a 256 -c "$shared_backup/SHA256"
  ```

  Expected: every checksum reports `OK`; do not reinstall OpenCode because both `opencode` and `opencode2` already resolve to V2.

### Task 2: Convert active shared configuration to V2 without exposing credentials

**Files:**
- Modify: `~/.config/opencode/opencode.json`
- Modify: `~/.agents-configs/opencode/work/opencode.json`
- Modify: `~/.agents-configs/opencode/home/opencode.json`
- Test: all three parse; `opencode debug paths`, `opencode mcp list`

- [ ] **Step 1: Write a failing configuration assertion against the current V1-shaped shared profiles.**

  Run:

  ```bash
  node --input-type=module <<'NODE'
  import { readFileSync } from 'node:fs'
  const work = JSON.parse(readFileSync(`${process.env.HOME}/.agents-configs/opencode/work/opencode.json`, 'utf8'))
  const home = JSON.parse(readFileSync(`${process.env.HOME}/.agents-configs/opencode/home/opencode.json`, 'utf8'))
  for (const [name, config] of Object.entries({ work, home })) {
    if (!Array.isArray(config.plugins)) throw new Error(`${name}: plugins must be an array`)
    if (!config.mcp?.servers || Array.isArray(config.mcp.servers)) throw new Error(`${name}: mcp.servers must be an object`)
    if (!Array.isArray(config.permissions ?? [])) throw new Error(`${name}: permissions must be an array`)
    if ('plugin' in config || 'permission' in config || 'experimental' in config) throw new Error(`${name}: contains a legacy key`)
  }
  NODE
  ```

  Expected: FAIL because work/home use `plugin`, flat `mcp`, `permission`, and quota `experimental` configuration.

- [ ] **Step 2: Rewrite only the configuration structure from the backups, preserving secret-bearing objects byte-for-byte in memory.**

  Run this deterministic transformation. It retains the global Slim/Chrome configuration and all named work references, converts only the documented V1 shapes, converts YouTrack `enabled: false` to `disabled: true`, and excludes quota/Claude legacy configuration without ever printing the Sentry token:

  ```bash
  global_backup="$(find "$HOME/.config/opencode/backups" -maxdepth 1 -type d -name 'v2-*' -print | sort | tail -1)"
  shared_backup="$(find "$HOME/.agents-configs/opencode/backups" -maxdepth 1 -type d -name 'v2-*' -print | sort | tail -1)"
  GLOBAL_BACKUP="$global_backup" SHARED_BACKUP="$shared_backup" node --input-type=module <<'NODE'
  import { readFileSync, writeFileSync } from 'node:fs'

  const read = (file) => JSON.parse(readFileSync(file, 'utf8'))
  const write = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  const home = process.env.HOME
  const global = read(`${process.env.GLOBAL_BACKUP}/opencode.json`)
  const work = read(`${process.env.SHARED_BACKUP}/work-opencode.json`)
  const profile = read(`${process.env.SHARED_BACKUP}/home-opencode.json`)

  delete global.lsp

  const workServers = work.mcp
  for (const server of Object.values(workServers)) {
    if (server && typeof server === 'object' && 'enabled' in server) {
      server.disabled = server.enabled === false
      delete server.enabled
    }
  }
  work.plugins = work.plugin.filter((item) => item !== '@slkiser/opencode-quota')
  delete work.plugin
  delete work.experimental
  work.mcp = { servers: workServers }
  work.permissions = Object.entries(work.permission.edit).map(([resource, effect]) => ({ action: 'edit', resource, effect }))
  delete work.permission

  profile.plugins = []
  delete profile.plugin
  delete profile.experimental
  profile.mcp = { servers: profile.mcp }
  profile.permissions = []

  write(`${home}/.config/opencode/opencode.json`, global)
  write(`${home}/.agents-configs/opencode/work/opencode.json`, work)
  write(`${home}/.agents-configs/opencode/home/opencode.json`, profile)
  NODE
  ```

  Do not change credential files, `service.json`, keychain entries, or SQLite state.

- [ ] **Step 3: Re-run the assertion and validate merged discovery.**

  Run:

  ```bash
  node --input-type=module <<'NODE'
  import { readFileSync } from 'node:fs'
  for (const file of [
    `${process.env.HOME}/.config/opencode/opencode.json`,
    `${process.env.HOME}/.agents-configs/opencode/work/opencode.json`,
    `${process.env.HOME}/.agents-configs/opencode/home/opencode.json`,
  ]) JSON.parse(readFileSync(file, 'utf8'))
  NODE
  cd /Users/kurbezz/work/ai_task_tracker
  opencode debug paths
  opencode mcp list
  ```

  Expected: JSON parsing succeeds; the work profile is discovered through `.opencode`; Chrome DevTools, Sentry, and AI Task Tracker appear, while YouTrack is disabled.

### Task 3: Make `/tt` a V2-discovered command with the current marker contract

**Files:**
- Create: `~/.config/opencode/commands/tt.md`
- Retain: `~/.config/opencode/command/tt.md` only in the Task 1 backup; remove its active V1 location after discovery succeeds
- Test: `opencode` command discovery and manual `/tt` inspection

- [ ] **Step 1: Create the V2 command with the existing two-lookup confirmation policy and the typed marker input.**

  Write `~/.config/opencode/commands/tt.md`:

  ```markdown
  ---
  description: Attach the current session to an existing ai_task_tracker task.
  ---

  Attach this session to ai_task_tracker task `$ARGUMENTS`.

  1. Call the `ai-task-tracker` MCP tool `get_task` with `task_id: "$ARGUMENTS"`. Confirm the project, title, and current status with the user before proceeding.
  2. Ask the user to explicitly confirm that this session should attach to the validated task. Do not attach, log, or call any other tracker tool until the user confirms.
  3. After explicit confirmation, call `get_task` again with `task_id: "$ARGUMENTS"`. Only if that result is successful and matches the requested task, call the custom OpenCode tool `task_tracker_mark_attachment_candidate` with `{ "task_id": "$ARGUMENTS" }`, then reply to the user. Do **not** call `add_task_log`, and do not use tracker REST or MCP logging for the attachment.
  4. For the rest of this session, follow the `tracking-ai-task-tracker` skill for status transitions, attention tags, and further logging.
  ```

- [ ] **Step 2: Verify V2 discovery before removing the legacy source.**

  Run:

  ```bash
  opencode debug paths
  test -f "$HOME/.config/opencode/commands/tt.md"
  ```

  Expected: the global plural `commands` directory is listed. In a manually started OpenCode V2 session, `/tt TASK-1` appears with the description above; do not call the real task tracker during this discovery check.

- [ ] **Step 3: Remove the active V1 command only after the discovery check.**

  Run:

  ```bash
  rm "$HOME/.config/opencode/command/tt.md"
  rmdir "$HOME/.config/opencode/command" 2>/dev/null || true
  ```

### Task 4: Port the plugin entrypoint to the V2 API with regression tests

**Files:**
- Modify: `opencode-plugin/package.json`
- Modify: `opencode-plugin/package-lock.json`
- Modify: `opencode-plugin/ai-task-tracker-nudge.ts`
- Modify: `opencode-plugin/ai-task-tracker-nudge.test.ts`
- Test: `opencode-plugin/ai-task-tracker-nudge.test.ts`

- [ ] **Step 1: Add failing V2 adapter tests without changing existing state, delivery, or queue tests.**

  Replace the legacy-hook shape assertions with tests that mock `Plugin.define` and a V2 context and assert all of the following:

  ```ts
  expect(ctx.session.hook).toHaveBeenCalledWith("prompt", expect.any(Function))
  expect(ctx.session.hook).toHaveBeenCalledWith("context", expect.any(Function))
  expect(ctx.tool.hook).toHaveBeenCalledWith("execute.after", expect.any(Function))
  expect(ctx.tool.transform).toHaveBeenCalledWith(expect.any(Function))
  expect(ctx.event.subscribe).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }))
  ```

  Add focused behavioral tests for: one stable prompt ID creates one turn; context hook appends typed system blocks but never starts a turn; a successful V2 `get_task` plus `task_tracker_mark_attachment_candidate({ task_id })` queues exactly one attachment; an error tool result never validates; only `session.idle` finalizes delivery; another session cannot trigger delivery; cleanup stops the worker and aborts the event subscription. Keep the existing `/tt` confirmation policy in the command test, not by parsing prompt text in the plugin.

- [ ] **Step 2: Run the new entrypoint tests and confirm the legacy API fails.**

  Run:

  ```bash
  cd /Users/kurbezz/work/ai_task_tracker/opencode-plugin
  npm install
  npm test -- ai-task-tracker-nudge.test.ts
  ```

  Expected: FAIL because the current entrypoint imports `@opencode-ai/plugin` and returns V1 hook names.

- [ ] **Step 3: Install the V2 SDK and update the entrypoint as a thin adapter.**

  Run:

  ```bash
  cd /Users/kurbezz/work/ai_task_tracker/opencode-plugin
  npm uninstall @opencode-ai/plugin
  npm install @opencode/plugin@beta
  ```

  Replace the legacy export with this V2 lifecycle structure. The V2 beta type declarations define prompt `sessionID`/`messageID`, context `sessionID`/typed `system`, execute-after `input`/`result`, and idle `event.data.sessionID`; do not use `never` casts:

  ```ts
  import { Plugin } from "@opencode/plugin";

  export default Plugin.define({
    id: "ai-task-tracker-nudge",
    async setup(ctx) {
      const controller = new AbortController();
      // Initialize the existing store, queue, worker, and turn tracker once here.
      await ctx.session.hook("prompt", async (event) => {
        turns?.onChatMessage({ sessionID: event.sessionID, messageID: event.messageID });
      });
      await ctx.session.hook("context", async (event) => {
        event.system.push({ type: "text", text: `## AI Task Tracker session\nCurrent opencode session id: ${event.sessionID}` });
        const state = store.get(event.sessionID);
        if (state.pendingReminder) {
          event.system.push({ type: "text", text: `## AI Task Tracker reminder\n${state.pendingReminder}` });
          state.pendingReminder = null;
        }
      });
      await ctx.tool.hook("execute.after", async (event) => {
        applyToolExecuteAfter(store.get(event.sessionID), {
          tool: event.tool,
          args: (event.input as Record<string, unknown>) ?? {},
          outputText: normalizeToolOutput(event.status === "completed" ? event.result : { isError: true }),
        });
      });
      await ctx.tool.transform((editor) => editor.add({
        name: "task_tracker_mark_attachment_candidate",
        description: "Queue a successfully validated task attachment for post-response delivery.",
        input: { type: "object", properties: { task_id: { type: "string", minLength: 1 } }, required: ["task_id"], additionalProperties: false },
        async execute(input, context) {
          const taskID = (input as { task_id: string }).task_id;
          const queued = await turns?.queueValidatedAttachment(context.sessionID, taskID);
          return { content: queued ? "Attachment candidate queued." : "No verified attachment candidate to queue." };
        },
      }));
      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type !== "session.idle") continue;
          const sessionID = event.data.sessionID;
          await turns?.onSessionIdle(sessionID);
          const state = store.get(sessionID);
          const rule = evaluateLifecycleReminder(state);
          if (rule) {
            state.remindedFor.add(rule.id);
            state.pendingReminder = rule.text;
            state.didCommitSinceLastReminder = false;
            state.didPushOrOpenPr = false;
            state.didDeployCommand = false;
          }
        }
      })();
      return () => { controller.abort(); worker?.stop(); };
    },
  });
  ```

  Do not resurrect `command.execute.before`, parse expanded `/tt` prompts, create UUIDs from context-hook calls, change `queueValidatedAttachment` behavior, or remove the error rejection in `normalizeToolOutput`. Resolve the V2 tool execution context's session ID using its installed typed callback contract; if V2 cannot provide a session ID to custom-tool execution, stop and report that compatibility blocker instead of storing a global last session.

- [ ] **Step 4: Run the V2 entrypoint tests and compile it.**

  Run:

  ```bash
  cd /Users/kurbezz/work/ai_task_tracker/opencode-plugin
  npm test -- ai-task-tracker-nudge.test.ts
  npm run typecheck
  ```

  Expected: PASS with no V1 import or legacy hook-key TypeScript errors.

- [ ] **Step 5: Commit only intentional plugin files, including the previously untracked output normalizer if it remains imported.**

  Run:

  ```bash
  cd /Users/kurbezz/work/ai_task_tracker
  git add opencode-plugin/package.json opencode-plugin/package-lock.json opencode-plugin/ai-task-tracker-nudge.ts opencode-plugin/ai-task-tracker-nudge.test.ts opencode-plugin/src/tool-output.ts
  git diff --cached --check
  git commit -m "feat: port task tracker nudge to OpenCode V2"
  ```

### Task 5: Validate the complete profile and preserve rollback evidence

**Files:**
- Modify: none unless Task 4 exposes a V2 type-contract defect
- Test: configuration, plugin, MCP, and controlled `/tt` verification

- [ ] **Step 1: Run static validation from the plugin directory.**

  Run:

  ```bash
  cd /Users/kurbezz/work/ai_task_tracker/opencode-plugin
  npm test
  npm run typecheck
  ```

  Expected: all existing unit tests, including queue, delivery, turn, tool-event, and entrypoint tests pass.

- [ ] **Step 2: Validate the active V2 service and loaded integrations.**

  Run:

  ```bash
  cd /Users/kurbezz/work/ai_task_tracker
  opencode service status
  opencode api get /api/health
  opencode debug paths
  opencode plugin list
  opencode plugin check
  opencode mcp list
  ```

  Expected: service health succeeds, `ai-task-tracker-nudge` has no load error, Chrome DevTools/Sentry/AI Task Tracker are registered, and the disabled YouTrack server is not started. Restart the service only if these commands report it unhealthy.

- [ ] **Step 3: Run a controlled `/tt` behavior check.**

  In a disposable session, invoke `/tt` with a real task only after confirming with the user. Verify the command asks for confirmation, performs the second lookup after confirmation, passes `task_id` to the marker, creates no `add_task_log` call before `session.idle`, and attaches only the current session. Then invoke `opencode run "Explain this repository in one sentence"` and confirm the V2 plugin loads without an error.

- [ ] **Step 4: Commit the configuration migration separately, leaving backups outside tracked project files.**

  Run:

  ```bash
  cd /Users/kurbezz/work/ai_task_tracker
  git status --short
  git diff --check
  ```

  Expected: only the plugin commit is added to this repository. Shared global configuration and backups remain outside the repository; report their paths and do not add them through the `.opencode` symlink.

## Plan self-review

- Spec coverage: Tasks 1–2 preserve and convert global/shared configuration, Task 3 ports `/tt`, Task 4 ports and tests the V2 plugin, and Task 5 validates the service, plugin, MCP, command, and rollback evidence.
- Compatibility: the plan does not rely on command-text parsing for attachment intent; it preserves explicit typed marker calls, session isolation, error-result rejection, and idle-only delivery.
- Safety: backups are unique and restricted, existing dirty files are snapshotted before edits, no credentials are printed, and no blanket staging/reset is used.
