import { describe, it, expect } from "vitest";
import { createSessionState, createSessionStore, startTurn } from "./state";

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

  it("uses the chat message id and restart-safe UUID fallbacks for turns", () => {
    const store = createSessionStore();
    const state = store.get("session-1");

    expect(startTurn(state, "message-1").id).toBe("message-1");
    expect(startTurn(state).id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("does not reuse fallback turn ids after a store restart", () => {
    const first = startTurn(createSessionStore().get("session-1")).id;
    const restarted = startTurn(createSessionStore().get("session-1")).id;

    expect(first).not.toBe(restarted);
  });

  it("snapshots the confirmed session task into each new turn", () => {
    const state = createSessionState();
    state.attachedTaskId = "TASK-42";

    expect(startTurn(state, "m-1").attachedTaskId).toBe("TASK-42");
    expect(startTurn(state, "m-2").attachedTaskId).toBe("TASK-42");
  });
});
