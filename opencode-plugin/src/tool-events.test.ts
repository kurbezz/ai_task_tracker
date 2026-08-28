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
