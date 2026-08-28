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
