# opencode Task Tracker Nudge Plugin + Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an opencode plugin that nudges (never acts for) the model to use the already-connected `ai-task-tracker` MCP tools at the right moments, plus a companion skill documenting the tracker's workflow conventions.

**Architecture:** A network-free opencode plugin (`opencode-plugin/ai-task-tracker-nudge.ts`) tracks per-session state by observing `tool.execute.after` and `session.idle` events, and injects a one-shot, model-only reminder via `experimental.chat.system.transform` when a rule matches. A separate `SKILL.md` documents the tracker's status/tag conventions for the model to consult directly.

**Tech Stack:** TypeScript (loaded directly by opencode's Bun runtime, no build step), Vitest for unit tests of the pure logic.

---

## Deviations from the approved spec (found during API research)

The design spec (`docs/superpowers/specs/2026-08-28-opencode-task-tracker-integration-design.md`) proposed detecting "deployment mentioned" by scanning chat message text via a `chat.message`-style hook. Research into the actual `@opencode-ai/plugin` API (confirmed against the opencode source and published hook types) found:

- The only confirmed hook for reading full chat content (`experimental.chat.messages.transform`) does **not** carry a `sessionID` in its input, so state couldn't reliably be attributed to the right session.
- `tool.execute.after` and `event` (`session.idle`) are fully confirmed with stable, session-scoped payloads.

**Resolution:** rule 5 ("everything is deployed" → nudge to `DONE`) is now driven by the same mechanism as the other rules — a bash command heuristic (`npm run deploy`, `docker push`, `flyctl deploy`, `vercel --prod`, `kubectl apply`, or the literal word `deploy`/`deployed` in a shell command) observed via `tool.execute.after`, instead of scanning chat text. This keeps every rule on the same confirmed, session-scoped API and avoids relying on an under-specified hook.

Everything else in the spec (5-stage status model, no network calls ever, one reminder per rule per session, plugin + skill split, file locations) is unchanged.

## Confirmed API reference (for implementers — do not deviate without re-verifying)

```ts
// Plugin shape
type Plugin = (input: PluginInput, options?: Record<string, unknown>) => Promise<Hooks>;

// tool.execute.after
"tool.execute.after"?: (
  input: { tool: string; sessionID: string; callID: string; args: any },
  output: { title: string; output: string; metadata: any },
) => Promise<void>;

// event
event?: (input: { event: Event }) => Promise<void>;
// session.idle event: { id: string; type: "session.idle"; properties: { sessionID: string } }

// experimental.chat.system.transform
"experimental.chat.system.transform"?: (
  input: { sessionID?: string; model: Model },
  output: { system: string[] },
) => Promise<void>;
```

MCP tool names are built as `sanitize(clientName) + "_" + sanitize(toolName)`, but the exact prefix/casing observed at runtime may differ between opencode builds (e.g. `mcp_Ai-task-tracker_create_task` vs `ai-task-tracker_create_task`). Built-in tool names (`bash`, `edit`, `write`, `read`) may also appear with or without an `mcp_`-style prefix depending on the running harness. **All matching in this plan is done with case-insensitive substring checks, never exact equality**, to stay robust to this. Task 9 includes a manual step to log and confirm the actual observed names in your environment.

---

### Task 1: Scaffold the plugin package

**Files:**
- Create: `opencode-plugin/package.json`
- Create: `opencode-plugin/tsconfig.json`

- [ ] **Step 1: Create the package manifest**

`opencode-plugin/package.json`:
```json
{
  "name": "ai-task-tracker-opencode-plugin",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@opencode-ai/plugin": "^1.0.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
```

- [ ] **Step 2: Create the TypeScript config**

`opencode-plugin/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "types": []
  },
  "include": ["**/*.ts"]
}
```

- [ ] **Step 3: Install dependencies**

Run: `npm install` (inside `opencode-plugin/`)
Expected: `node_modules/` and `package-lock.json` created, no errors.

- [ ] **Step 4: Commit**

```bash
git add opencode-plugin/package.json opencode-plugin/package-lock.json opencode-plugin/tsconfig.json
git commit -m "chore: scaffold opencode-plugin package"
```

---

### Task 2: Pure matcher functions

**Files:**
- Create: `opencode-plugin/src/matchers.ts`
- Test: `opencode-plugin/src/matchers.test.ts`

- [ ] **Step 1: Write the failing tests**

`opencode-plugin/src/matchers.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  isCommitCommand,
  isPushOrPrCommand,
  isDeployCommand,
  isPlanOrSpecPath,
  extractTrackerToolName,
  toolNameIncludes,
} from "./matchers";

describe("isCommitCommand", () => {
  it("matches a plain git commit", () => {
    expect(isCommitCommand('git commit -m "feat: x"')).toBe(true);
  });

  it("matches git commit chained after other commands", () => {
    expect(isCommitCommand('git add . && git commit -m "x"')).toBe(true);
  });

  it("does not match unrelated commands", () => {
    expect(isCommitCommand("git status")).toBe(false);
  });
});

describe("isPushOrPrCommand", () => {
  it("matches git push", () => {
    expect(isPushOrPrCommand("git push origin master")).toBe(true);
  });

  it("matches gh pr create", () => {
    expect(isPushOrPrCommand("gh pr create --fill")).toBe(true);
  });

  it("does not match git pull", () => {
    expect(isPushOrPrCommand("git pull")).toBe(false);
  });
});

describe("isDeployCommand", () => {
  it("matches a command mentioning deploy", () => {
    expect(isDeployCommand("npm run deploy")).toBe(true);
  });

  it("matches docker push", () => {
    expect(isDeployCommand("docker push registry/app:latest")).toBe(true);
  });

  it("does not match an unrelated command", () => {
    expect(isDeployCommand("git status")).toBe(false);
  });
});

describe("isPlanOrSpecPath", () => {
  it("matches a spec path", () => {
    expect(isPlanOrSpecPath("docs/superpowers/specs/2026-08-28-x-design.md")).toBe(true);
  });

  it("matches a plan path", () => {
    expect(isPlanOrSpecPath("docs/superpowers/plans/2026-08-28-x.md")).toBe(true);
  });

  it("does not match an unrelated markdown file", () => {
    expect(isPlanOrSpecPath("README.md")).toBe(false);
  });
});

describe("extractTrackerToolName", () => {
  it("extracts the tool name from a prefixed MCP tool id", () => {
    expect(extractTrackerToolName("mcp_Ai-task-tracker_create_task")).toBe("create_task");
  });

  it("extracts the tool name without an mcp_ prefix", () => {
    expect(extractTrackerToolName("ai-task-tracker_transition_task_status")).toBe(
      "transition_task_status",
    );
  });

  it("returns null for unrelated tools", () => {
    expect(extractTrackerToolName("bash")).toBeNull();
  });
});

describe("toolNameIncludes", () => {
  it("matches case-insensitively", () => {
    expect(toolNameIncludes("mcp_Bash", "bash")).toBe(true);
  });

  it("returns false when absent", () => {
    expect(toolNameIncludes("mcp_Edit", "bash")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd opencode-plugin && npx vitest run src/matchers.test.ts`
Expected: FAIL with "Cannot find module './matchers'" (or similar — the file doesn't exist yet).

- [ ] **Step 3: Implement the matchers**

`opencode-plugin/src/matchers.ts`:
```ts
export function isCommitCommand(command: string): boolean {
  return /(^|&&|;|\|)\s*git\s+commit\b/.test(command);
}

export function isPushOrPrCommand(command: string): boolean {
  return (
    /(^|&&|;|\|)\s*git\s+push\b/.test(command) ||
    /(^|&&|;|\|)\s*gh\s+pr\s+create\b/.test(command) ||
    /(^|&&|;|\|)\s*glab\s+mr\s+create\b/.test(command)
  );
}

export function isDeployCommand(command: string): boolean {
  return (
    /\bdeploy(ed)?\b/i.test(command) ||
    /(^|&&|;|\|)\s*docker\s+push\b/.test(command) ||
    /(^|&&|;|\|)\s*(flyctl|fly)\s+deploy\b/.test(command) ||
    /(^|&&|;|\|)\s*vercel\b.*--prod\b/.test(command) ||
    /(^|&&|;|\|)\s*railway\s+up\b/.test(command) ||
    /(^|&&|;|\|)\s*kubectl\s+(apply|rollout)\b/.test(command)
  );
}

export function isPlanOrSpecPath(path: string): boolean {
  return /docs\/.*\/(specs|plans)\/[^/]+\.md$/.test(path);
}

export function extractTrackerToolName(toolId: string): string | null {
  const match = /task[-_]tracker[-_](.+)$/i.exec(toolId);
  return match ? match[1].toLowerCase() : null;
}

export function toolNameIncludes(toolId: string, needle: string): boolean {
  return toolId.toLowerCase().includes(needle.toLowerCase());
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd opencode-plugin && npx vitest run src/matchers.test.ts`
Expected: PASS, all 14 tests green.

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/matchers.ts opencode-plugin/src/matchers.test.ts
git commit -m "feat: add opencode-plugin matcher functions"
```

---

### Task 3: Session state store

**Files:**
- Create: `opencode-plugin/src/state.ts`
- Test: `opencode-plugin/src/state.test.ts`

- [ ] **Step 1: Write the failing tests**

`opencode-plugin/src/state.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createSessionState, createSessionStore } from "./state";

describe("createSessionState", () => {
  it("starts with no task, no status, and no flags set", () => {
    const state = createSessionState();
    expect(state.taskId).toBeNull();
    expect(state.status).toBeNull();
    expect(state.hadMutatingToolCall).toBe(false);
    expect(state.remindedFor.size).toBe(0);
    expect(state.pendingReminder).toBeNull();
  });
});

describe("createSessionStore", () => {
  it("returns the same state object for the same session id", () => {
    const store = createSessionStore();
    const a = store.get("session-1");
    a.taskId = "task-1";
    const b = store.get("session-1");
    expect(b.taskId).toBe("task-1");
  });

  it("returns independent state for different session ids", () => {
    const store = createSessionStore();
    const a = store.get("session-1");
    a.taskId = "task-1";
    const b = store.get("session-2");
    expect(b.taskId).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd opencode-plugin && npx vitest run src/state.test.ts`
Expected: FAIL with "Cannot find module './state'".

- [ ] **Step 3: Implement the state store**

`opencode-plugin/src/state.ts`:
```ts
export type TrackerStatus = "TO_DO" | "TO_AGENT" | "TO_REVIEW" | "TO_DEPLOY" | "DONE";

export type SessionState = {
  taskId: string | null;
  status: TrackerStatus | null;
  hadMutatingToolCall: boolean;
  sawPlanOrSpecContext: boolean;
  didCommitSinceLastReminder: boolean;
  didPushOrOpenPr: boolean;
  didDeployCommand: boolean;
  remindedFor: Set<string>;
  pendingReminder: string | null;
};

export function createSessionState(): SessionState {
  return {
    taskId: null,
    status: null,
    hadMutatingToolCall: false,
    sawPlanOrSpecContext: false,
    didCommitSinceLastReminder: false,
    didPushOrOpenPr: false,
    didDeployCommand: false,
    remindedFor: new Set(),
    pendingReminder: null,
  };
}

export type SessionStore = {
  get(sessionID: string): SessionState;
};

export function createSessionStore(): SessionStore {
  const sessions = new Map<string, SessionState>();
  return {
    get(sessionID: string): SessionState {
      let state = sessions.get(sessionID);
      if (!state) {
        state = createSessionState();
        sessions.set(sessionID, state);
      }
      return state;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd opencode-plugin && npx vitest run src/state.test.ts`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/state.ts opencode-plugin/src/state.test.ts
git commit -m "feat: add opencode-plugin session state store"
```

---

### Task 4: Reminder rule evaluator

**Files:**
- Create: `opencode-plugin/src/reminders.ts`
- Test: `opencode-plugin/src/reminders.test.ts`

- [ ] **Step 1: Write the failing tests**

`opencode-plugin/src/reminders.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createSessionState } from "./state";
import { evaluateReminder } from "./reminders";

describe("evaluateReminder", () => {
  it("returns null for a fresh session with no signals", () => {
    const state = createSessionState();
    expect(evaluateReminder(state)).toBeNull();
  });

  it("suggests creating a task when changes were made without one", () => {
    const state = createSessionState();
    state.hadMutatingToolCall = true;
    const rule = evaluateReminder(state);
    expect(rule?.id).toBe("create-task");
  });

  it("suggests TO_AGENT when a task is TO_DO with plan context", () => {
    const state = createSessionState();
    state.taskId = "task-1";
    state.status = "TO_DO";
    state.sawPlanOrSpecContext = true;
    const rule = evaluateReminder(state);
    expect(rule?.id).toBe("to-agent");
  });

  it("suggests TO_REVIEW when TO_AGENT and a commit happened", () => {
    const state = createSessionState();
    state.taskId = "task-1";
    state.status = "TO_AGENT";
    state.didCommitSinceLastReminder = true;
    const rule = evaluateReminder(state);
    expect(rule?.id).toBe("to-review");
  });

  it("suggests TO_DEPLOY when TO_REVIEW and a push/PR happened", () => {
    const state = createSessionState();
    state.taskId = "task-1";
    state.status = "TO_REVIEW";
    state.didPushOrOpenPr = true;
    const rule = evaluateReminder(state);
    expect(rule?.id).toBe("to-deploy");
  });

  it("suggests DONE when TO_DEPLOY and a deploy command happened", () => {
    const state = createSessionState();
    state.taskId = "task-1";
    state.status = "TO_DEPLOY";
    state.didDeployCommand = true;
    const rule = evaluateReminder(state);
    expect(rule?.id).toBe("done");
  });

  it("never repeats a rule already reminded for", () => {
    const state = createSessionState();
    state.hadMutatingToolCall = true;
    state.remindedFor.add("create-task");
    expect(evaluateReminder(state)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd opencode-plugin && npx vitest run src/reminders.test.ts`
Expected: FAIL with "Cannot find module './reminders'".

- [ ] **Step 3: Implement the reminder rules**

`opencode-plugin/src/reminders.ts`:
```ts
import type { SessionState } from "./state";

export type ReminderRule = {
  id: string;
  matches: (state: SessionState) => boolean;
  text: string;
};

export const REMINDER_RULES: ReminderRule[] = [
  {
    id: "create-task",
    matches: (s) => s.taskId === null && s.hadMutatingToolCall,
    text:
      "This session has made changes but has no linked AI Task Tracker task yet. Consider calling create_task (or confirm to the user that no task is needed for this work).",
  },
  {
    id: "to-agent",
    matches: (s) => s.status === "TO_DO" && s.sawPlanOrSpecContext,
    text:
      "A spec/plan is in place for this task. Consider transition_task_status to TO_AGENT before starting implementation.",
  },
  {
    id: "to-review",
    matches: (s) => s.status === "TO_AGENT" && s.didCommitSinceLastReminder,
    text:
      "A commit was made on this task. Consider add_task_log with a summary and transition_task_status to TO_REVIEW.",
  },
  {
    id: "to-deploy",
    matches: (s) => s.status === "TO_REVIEW" && s.didPushOrOpenPr,
    text: "A push or PR/MR was detected for this task. Consider transition_task_status to TO_DEPLOY.",
  },
  {
    id: "done",
    matches: (s) => s.status === "TO_DEPLOY" && s.didDeployCommand,
    text: "A deploy-looking command was detected for this task. Consider transition_task_status to DONE.",
  },
];

export function evaluateReminder(state: SessionState): ReminderRule | null {
  for (const rule of REMINDER_RULES) {
    if (state.remindedFor.has(rule.id)) continue;
    if (rule.matches(state)) return rule;
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd opencode-plugin && npx vitest run src/reminders.test.ts`
Expected: PASS, all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/reminders.ts opencode-plugin/src/reminders.test.ts
git commit -m "feat: add opencode-plugin reminder rule evaluator"
```

---

### Task 5: Tool-event state updates

**Files:**
- Create: `opencode-plugin/src/tool-events.ts`
- Test: `opencode-plugin/src/tool-events.test.ts`

- [ ] **Step 1: Write the failing tests**

`opencode-plugin/src/tool-events.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createSessionState } from "./state";
import { applyToolExecuteAfter } from "./tool-events";

describe("applyToolExecuteAfter", () => {
  it("flags a mutating bash command and detects a commit", () => {
    const state = createSessionState();
    applyToolExecuteAfter(state, {
      tool: "mcp_Bash",
      args: { command: 'git commit -m "x"' },
      outputText: "ok",
    });
    expect(state.hadMutatingToolCall).toBe(true);
    expect(state.didCommitSinceLastReminder).toBe(true);
  });

  it("detects a push", () => {
    const state = createSessionState();
    applyToolExecuteAfter(state, {
      tool: "bash",
      args: { command: "git push origin master" },
      outputText: "ok",
    });
    expect(state.didPushOrOpenPr).toBe(true);
  });

  it("detects a deploy command", () => {
    const state = createSessionState();
    applyToolExecuteAfter(state, {
      tool: "bash",
      args: { command: "npm run deploy" },
      outputText: "ok",
    });
    expect(state.didDeployCommand).toBe(true);
  });

  it("captures task id and status from create_task output", () => {
    const state = createSessionState();
    applyToolExecuteAfter(state, {
      tool: "mcp_Ai-task-tracker_create_task",
      args: { project_id: "p1", title: "x" },
      outputText: JSON.stringify({ id: "task-1", status: "TO_DO" }),
    });
    expect(state.taskId).toBe("task-1");
    expect(state.status).toBe("TO_DO");
  });

  it("captures status from a transition_task_status call's args", () => {
    const state = createSessionState();
    applyToolExecuteAfter(state, {
      tool: "mcp_Ai-task-tracker_transition_task_status",
      args: { task_id: "task-1", status: "TO_AGENT" },
      outputText: JSON.stringify({ id: "task-1", status: "TO_AGENT" }),
    });
    expect(state.status).toBe("TO_AGENT");
  });

  it("flags plan/spec context from a read path", () => {
    const state = createSessionState();
    applyToolExecuteAfter(state, {
      tool: "mcp_Read",
      args: { filePath: "docs/superpowers/plans/2026-08-28-x.md" },
      outputText: "",
    });
    expect(state.sawPlanOrSpecContext).toBe(true);
  });

  it("ignores malformed tool output without throwing", () => {
    const state = createSessionState();
    expect(() =>
      applyToolExecuteAfter(state, {
        tool: "mcp_Ai-task-tracker_get_task",
        args: { task_id: "task-1" },
        outputText: "not json",
      }),
    ).not.toThrow();
    expect(state.taskId).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd opencode-plugin && npx vitest run src/tool-events.test.ts`
Expected: FAIL with "Cannot find module './tool-events'".

- [ ] **Step 3: Implement the tool-event handler**

`opencode-plugin/src/tool-events.ts`:
```ts
import type { SessionState, TrackerStatus } from "./state";
import {
  isCommitCommand,
  isPushOrPrCommand,
  isDeployCommand,
  isPlanOrSpecPath,
  extractTrackerToolName,
  toolNameIncludes,
} from "./matchers";

export type ToolAfterEvent = {
  tool: string;
  args: Record<string, unknown>;
  outputText: string;
};

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "TO_DO",
  "TO_AGENT",
  "TO_REVIEW",
  "TO_DEPLOY",
  "DONE",
]);

export function applyToolExecuteAfter(state: SessionState, event: ToolAfterEvent): void {
  const { tool, args, outputText } = event;
  const command = typeof args.command === "string" ? args.command : null;

  if (command && toolNameIncludes(tool, "bash")) {
    if (isCommitCommand(command)) state.didCommitSinceLastReminder = true;
    if (isPushOrPrCommand(command)) state.didPushOrOpenPr = true;
    if (isDeployCommand(command)) state.didDeployCommand = true;
  }

  if (
    toolNameIncludes(tool, "bash") ||
    toolNameIncludes(tool, "edit") ||
    toolNameIncludes(tool, "write")
  ) {
    state.hadMutatingToolCall = true;
  }

  const trackerTool = extractTrackerToolName(tool);
  if (trackerTool === "create_task" || trackerTool === "get_task") {
    const parsed = tryParseJson(outputText);
    if (parsed && typeof parsed.id === "string") state.taskId = parsed.id;
    if (parsed && typeof parsed.status === "string" && VALID_STATUSES.has(parsed.status)) {
      state.status = parsed.status as TrackerStatus;
    }
  }
  if (
    trackerTool === "transition_task_status" &&
    typeof args.status === "string" &&
    VALID_STATUSES.has(args.status)
  ) {
    state.status = args.status as TrackerStatus;
  }

  const path =
    typeof args.filePath === "string"
      ? args.filePath
      : typeof args.path === "string"
        ? args.path
        : null;
  if (path && isPlanOrSpecPath(path)) {
    state.sawPlanOrSpecContext = true;
  }
}

function tryParseJson(text: string): Record<string, unknown> | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd opencode-plugin && npx vitest run src/tool-events.test.ts`
Expected: PASS, all 7 tests green.

- [ ] **Step 5: Run the full test suite**

Run: `cd opencode-plugin && npm test`
Expected: PASS, all tests across all files green (31 tests total: 14 + 3 + 7 + 7).

- [ ] **Step 6: Commit**

```bash
git add opencode-plugin/src/tool-events.ts opencode-plugin/src/tool-events.test.ts
git commit -m "feat: add opencode-plugin tool-event state updates"
```

---

### Task 6: Wire the plugin entry point

**Files:**
- Create: `opencode-plugin/ai-task-tracker-nudge.ts`

- [ ] **Step 1: Implement the entry point**

`opencode-plugin/ai-task-tracker-nudge.ts`:
```ts
import type { Plugin } from "@opencode-ai/plugin";
import { createSessionStore } from "./src/state";
import { applyToolExecuteAfter } from "./src/tool-events";
import { evaluateReminder } from "./src/reminders";

export const AiTaskTrackerNudge: Plugin = async () => {
  const store = createSessionStore();

  return {
    "tool.execute.after": async (input, output) => {
      const state = store.get(input.sessionID);
      applyToolExecuteAfter(state, {
        tool: input.tool,
        args: (input.args as Record<string, unknown>) ?? {},
        outputText: output.output ?? "",
      });
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return;
      const sessionID = (event as { properties: { sessionID: string } }).properties.sessionID;
      const state = store.get(sessionID);
      const rule = evaluateReminder(state);
      if (!rule) return;
      state.remindedFor.add(rule.id);
      state.pendingReminder = rule.text;
      state.didCommitSinceLastReminder = false;
      state.didPushOrOpenPr = false;
      state.didDeployCommand = false;
    },

    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input.sessionID;
      if (!sessionID) return;
      const state = store.get(sessionID);
      if (!state.pendingReminder) return;
      output.system.push(`## AI Task Tracker reminder\n${state.pendingReminder}`);
      state.pendingReminder = null;
    },
  };
};

export default AiTaskTrackerNudge;
```

This file is intentionally thin — all logic it calls is already unit-tested in Task 2–5. It cannot itself be unit-tested without a running opencode process (the `Plugin` type, hook dispatch, and event payloads are provided by the opencode runtime), so its correctness is verified via the manual smoke test in Task 9.

- [ ] **Step 2: Typecheck**

Run: `cd opencode-plugin && npm run typecheck`
Expected: no errors. If `@opencode-ai/plugin`'s published types don't match the signatures documented in this plan's "Confirmed API reference" section, adjust the entry point to match the installed package's actual `.d.ts` (check `node_modules/@opencode-ai/plugin/dist/index.d.ts`) rather than guessing — the installed types are the ground truth at implementation time.

- [ ] **Step 3: Commit**

```bash
git add opencode-plugin/ai-task-tracker-nudge.ts
git commit -m "feat: wire ai-task-tracker-nudge opencode plugin entry point"
```

---

### Task 7: Register the plugin in the shared work config

**Files:**
- Modify: `~/.agents-configs/opencode/work/opencode.json` (tracked in a separate `agents-configs` git repo, not this repo)

- [ ] **Step 1: Replace the dead plugin path**

In `~/.agents-configs/opencode/work/opencode.json`, change:
```json
"plugin": [
  "@slkiser/opencode-quota",
  "file:///Users/kurbezz/work/ai_skills/ai-task-tracker/src/opencode-plugin.ts"
],
```
to:
```json
"plugin": [
  "@slkiser/opencode-quota",
  "file:///Users/kurbezz/work/ai_task_tracker/opencode-plugin/ai-task-tracker-nudge.ts"
],
```

- [ ] **Step 2: Verify the JSON is still valid**

Run: `python3 -m json.tool ~/.agents-configs/opencode/work/opencode.json > /dev/null && echo valid`
Expected: `valid` printed, no error.

- [ ] **Step 3: Commit in the agents-configs repo**

```bash
cd ~/.agents-configs && git add opencode/work/opencode.json && git commit -m "fix: point ai-task-tracker plugin at its actual location in ai_task_tracker repo"
```

(This is a separate repo from `ai_task_tracker` — do not attempt to commit this file from inside the `ai_task_tracker` working tree.)

---

### Task 8: Write the companion skill

**Files:**
- Create: `~/.agents-configs/opencode/work/skills/ai-task-tracker/SKILL.md`

- [ ] **Step 1: Write the skill file**

`~/.agents-configs/opencode/work/skills/ai-task-tracker/SKILL.md`:
```markdown
---
name: ai-task-tracker
description: Use when self-reporting progress to the AI Task Tracker — deciding when to create a task, which status to transition to, when to apply NEEDS_USER_INPUT/BLOCKED/FAILED tags, or how to write a task_logs entry.
---

# AI Task Tracker conventions

The tracker is reached through the already-connected `ai-task-tracker` MCP tools
(`create_task`, `get_task`, `list_projects`, `list_project_tasks`,
`transition_task_status`, `add_task_log`, `add_task_tag`, `remove_task_tag`,
`update_task`, `delete_task`). This skill explains *when* and *how* to call them —
it never calls them for you.

## Status pipeline

Fixed, linear, one-step-forward-or-any-step-backward:

```
TO_DO → TO_AGENT → TO_REVIEW → TO_DEPLOY → DONE
```

- `TO_DO`: task exists, spec/plan not finalized yet.
- `TO_AGENT`: spec/plan is ready, work is about to start (or is in progress).
- `TO_REVIEW`: implementation is committed, awaiting review.
- `TO_DEPLOY`: review passed, ready to ship.
- `DONE`: shipped/merged/deployed.

`transition_task_status` rejects invalid jumps (anything except the next stage or
any earlier stage). If a transition is rejected, don't force it — check
`get_task` for the current status first.

## Tags

- `NEEDS_USER_INPUT` — you need a decision or input from the owner before
  continuing. Apply it, add a `task_logs` entry explaining exactly what's
  needed, and stop making unrelated progress on that task until it's resolved.
- `BLOCKED` — blocked by something external (a dependency, an environment
  issue, a third-party outage). Same pattern: tag + log entry with the reason.
- `FAILED` — an attempt failed. There is no separate pipeline status for this:
  the task stays at its current status, you attach `FAILED` plus a log entry
  describing what was tried and why it failed.
- Freeform custom tags are allowed for anything else worth flagging.

Remove a tag (`remove_task_tag`) once the blocking condition is actually
resolved — don't leave stale tags on a task that's moving again.

## Logging conventions

- `author`: identify who/what is reporting — your agent/model identifier, not
  a generic value like `"assistant"`.
- `message`: a concrete statement of what happened or what's needed next —
  not a restatement of a tool call (avoid things like "called create_task").
  Good: "Implemented the 5-stage status migration; backend tests green,
  frontend board updated." Bad: "Did the work."

## When to create a task

Before starting non-trivial changes in a session that has no task linked yet,
create one via `create_task` with a clear `title` and the `project_id` for
the relevant project (use `list_projects` if you don't know it). For genuinely
trivial one-off actions (a one-line fix, answering a question), it's fine to
skip the tracker — use judgment, don't create noise tasks.

## Worked example

```
create_task(project_id, title="Add dark mode toggle")
  → { id: "abc123", status: "TO_DO", ... }
transition_task_status(task_id="abc123", status="TO_AGENT")
... implementation happens ...
add_task_log(task_id="abc123", author="claude-sonnet", message="Implemented toggle + persisted preference; tests green.")
transition_task_status(task_id="abc123", status="TO_REVIEW")
... reviewer asks a question the owner needs to answer ...
add_task_tag(task_id="abc123", name="NEEDS_USER_INPUT")
add_task_log(task_id="abc123", author="claude-sonnet", message="Need owner decision: should the toggle persist per-device or per-account?")
... owner answers, work resumes ...
remove_task_tag(task_id="abc123", tag_id="<needs-user-input-tag-id>")
transition_task_status(task_id="abc123", status="TO_DEPLOY")
transition_task_status(task_id="abc123", status="DONE")
```
```

- [ ] **Step 2: Verify the skill loads without error**

Restart opencode (config, including skills, is not hot-reloaded), start a new session inside `ai_task_tracker` (or any repo using this shared config), and run `/skills` or equivalent listing command if available, or simply ask "what skills do you have access to related to ai-task-tracker" and confirm `ai-task-tracker` is listed with its description.

---

### Task 9: Manual smoke test and final verification

**Files:** none (verification only)

- [ ] **Step 1: Restart opencode**

Per the `customize-opencode` skill: config is loaded once at startup. Quit and restart opencode entirely (not just start a new session) so the updated `plugin` array and new skill are picked up.

- [ ] **Step 2: Confirm the plugin loads without error**

Start a new opencode session in `ai_task_tracker`. Check opencode's startup/log output (or run a trivial prompt) for any plugin load error referencing `ai-task-tracker-nudge.ts`. If there's a type or runtime error, it will typically surface here rather than silently — fix before proceeding.

- [ ] **Step 3: Confirm the actual tool-name convention in this environment**

Ask the model to run a trivial `bash` command (e.g. `pwd`) and call `mcp_Ai-task-tracker_ping`. If you have access to plugin debug logging (temporarily add `console.error("[nudge] tool.execute.after", input.tool)` inside the entry point and check opencode's stderr/log output), confirm the literal strings observed for the bash tool and for the tracker ping tool. Compare against the substring-matching heuristics in `matchers.ts` (`toolNameIncludes`, `extractTrackerToolName`) — if the observed names don't contain `"bash"` / `"task-tracker"` as substrings at all, adjust the matchers' needles accordingly and re-run the Task 2/5 test suites.

- [ ] **Step 4: Walk through the full nudge sequence**

In a scratch session:
1. Edit any file in the repo → go idle → expect (via the debug logging added in Step 3, or by asking the model "do you have any pending AI Task Tracker reminder in context?") the `create-task` reminder to fire once.
2. Have the model call `create_task` for a throwaway test task, then `transition_task_status` to `TO_AGENT`.
3. Run `git commit --allow-empty -m "test: nudge smoke test"` → go idle → expect the `to-review` reminder.
4. Run `git push` (to a throwaway branch, not `master`, to avoid triggering a real deploy) → go idle → expect the `to-deploy` reminder.
5. Run a command containing the word `deploy` (e.g. `echo deploy-test`) → go idle → expect the `done` reminder.
6. Confirm no reminder repeats within the same session once fired.

- [ ] **Step 5: Clean up the throwaway test task**

Call `delete_task` on the test task created in Step 4, or leave it and manually delete it via the tracker UI.

- [ ] **Step 6: Remove any temporary debug logging**

If `console.error` debug lines were added in Step 3, remove them.

```bash
git add opencode-plugin/ai-task-tracker-nudge.ts
git commit -m "chore: remove smoke-test debug logging" --allow-empty
```

(Use `--allow-empty` only if Step 6 turns out to have nothing to remove because none was added; otherwise omit the flag.)
