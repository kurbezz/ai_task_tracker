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
