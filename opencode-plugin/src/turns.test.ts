import { describe, expect, it, vi } from "vitest";
import type { TrackingQueue } from "./queue";
import { createSessionStore } from "./state";
import { applyToolExecuteAfter } from "./tool-events";
import { createTurnTracker, getResponseProgressCandidate, markPendingAttachmentConfirmable } from "./turns";

function queue(enqueue: TrackingQueue["enqueue"] = async () => true): TrackingQueue {
  return {
    enqueue,
    dueAt: async () => [],
    removeDelivered: async () => false,
    markRetry: async () => false,
    markTerminal: async () => false,
    markDeliveryEligible: async () => false,
  };
}

function successfulGetTask(state: ReturnType<ReturnType<typeof createSessionStore>["get"]>, taskId: string): void {
  applyToolExecuteAfter(state, {
    tool: "mcp_Ai-task-tracker_get_task",
    args: { task_id: taskId },
    outputText: JSON.stringify({ id: taskId, status: "TO_DO" }),
  });
}

describe("turn tracker", () => {
  it("retains /tt as pending intent and binds it only to the later chat turn", async () => {
    const enqueue = vi.fn<TrackingQueue["enqueue"]>().mockResolvedValue(true);
    const store = createSessionStore();
    const tracker = createTurnTracker(store, { queue: queue(enqueue), worker: { signal: vi.fn() }, author: "configured-agent" });

    tracker.onChatMessage({ sessionID: "s-1", messageID: "old-turn" });
    tracker.onCommandExecuteBefore({ command: "tt", sessionID: "s-1", arguments: "TASK-42" });
    const state = store.get("s-1");
    expect(state.currentTurn?.pendingAttachment).toBeNull();
    expect(state.pendingAttachmentTaskId).toBe("TASK-42");

    tracker.onChatMessage({ sessionID: "s-1", messageID: "new-turn" });
    expect(state.pendingAttachmentTaskId).toBeNull();
    expect(state.currentTurn?.pendingAttachment?.event.taskId).toBe("TASK-42");
    expect(state.currentTurn?.pendingAttachment?.event.eventId).toBe("task-attached:new-turn");
    await tracker.onSessionIdle("s-1");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("ignores malformed /tt arguments and never starts a fallback turn", () => {
    const store = createSessionStore();
    const tracker = createTurnTracker(store, { queue: queue(), worker: { signal: vi.fn() } });

    tracker.onCommandExecuteBefore({ command: "tt", sessionID: "s-1", arguments: "" });
    tracker.onCommandExecuteBefore({ command: "tt", sessionID: "s-1", arguments: "TASK-1 extra" });
    tracker.onCommandExecuteBefore({ command: "other", sessionID: "s-1", arguments: "TASK-1" });

    const state = store.get("s-1");
    expect(state.currentTurn).toBeNull();
    expect(state.pendingAttachmentTaskId).toBeNull();
  });

  it("requires a matching successful get_task marker before an explicit confirmation queues the attachment with its configured author", async () => {
    const enqueue = vi.fn<TrackingQueue["enqueue"]>().mockResolvedValue(true);
    const signal = vi.fn();
    const store = createSessionStore();
    const tracker = createTurnTracker(store, { queue: queue(enqueue), worker: { signal }, author: "configured-agent" });
    tracker.onCommandExecuteBefore({ command: "tt", sessionID: "s-1", arguments: "TASK-42" });
    tracker.onChatMessage({ sessionID: "s-1", messageID: "m-1" });

    await expect(tracker.confirmPendingAttachment("s-1")).resolves.toBe(false);
    successfulGetTask(store.get("s-1"), "TASK-42");
    await expect(tracker.confirmPendingAttachment("s-1")).resolves.toBe(true);

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      kind: "task-attached",
      taskId: "TASK-42",
      author: "configured-agent",
    }));
    expect(signal).not.toHaveBeenCalled();
    expect(store.get("s-1").attachedTaskId).toBe("TASK-42");
  });

  it("exposes a pure marker that rejects a missing, wrong-turn, or wrong-task pending attachment", () => {
    const store = createSessionStore();
    const state = store.get("s-1");
    expect(markPendingAttachmentConfirmable(state, "TASK-42")).toBe(false);

    state.pendingAttachmentTaskId = "TASK-42";
    trackerFor(store).onChatMessage({ sessionID: "s-1", messageID: "m-1" });
    expect(markPendingAttachmentConfirmable(state, "other")).toBe(false);
    expect(markPendingAttachmentConfirmable(state, "TASK-42")).toBe(true);
  });

  it("snapshots a confirmed task into future turns so their successful transitions create progress candidates", async () => {
    const enqueue = vi.fn<TrackingQueue["enqueue"]>().mockResolvedValue(true);
    const store = createSessionStore();
    const tracker = createTurnTracker(store, { queue: queue(enqueue), worker: { signal: vi.fn() }, author: "configured-agent" });
    tracker.onCommandExecuteBefore({ command: "tt", sessionID: "s-1", arguments: "task-1" });
    tracker.onChatMessage({ sessionID: "s-1", messageID: "m-1" });
    successfulGetTask(store.get("s-1"), "task-1");
    await tracker.confirmPendingAttachment("s-1");
    tracker.onChatMessage({ sessionID: "s-1", messageID: "m-2" });

    applyToolExecuteAfter(store.get("s-1"), {
      tool: "mcp_Ai-task-tracker_transition_task_status",
      args: { task_id: "task-1", status: "TO_REVIEW" },
      outputText: JSON.stringify({ id: "task-1", status: "TO_REVIEW" }),
    });
    expect(getResponseProgressCandidate(store.get("s-1"))).toEqual(expect.objectContaining({ taskId: "task-1" }));
    await tracker.onSessionIdle("s-1");

    expect(enqueue.mock.calls.map(([event]) => event)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "response-progress", taskId: "task-1", eventId: "response-progress:m-2", author: "configured-agent" }),
    ]));
  });

  it("uses UUID-derived response ids that cannot collide after a tracker store restart", async () => {
    const eventIdForRestart = async () => {
      const enqueue = vi.fn<TrackingQueue["enqueue"]>().mockResolvedValue(true);
      const store = createSessionStore();
      const tracker = createTurnTracker(store, { queue: queue(enqueue), worker: { signal: vi.fn() } });
      const state = store.get("s-1");
      state.attachedTaskId = "task-1";
      tracker.onChatMessage({ sessionID: "s-1" });
      applyToolExecuteAfter(state, {
        tool: "mcp_Ai-task-tracker_transition_task_status",
        args: { task_id: "task-1", status: "DONE" },
        outputText: JSON.stringify({ id: "task-1", status: "DONE" }),
      });
      await tracker.onSessionIdle("s-1");
      return enqueue.mock.calls[0][0].eventId;
    };

    const beforeRestart = await eventIdForRestart();
    const afterRestart = await eventIdForRestart();
    expect(beforeRestart).toMatch(/^response-progress:[0-9a-f-]{36}$/i);
    expect(afterRestart).toMatch(/^response-progress:[0-9a-f-]{36}$/i);
    expect(afterRestart).not.toBe(beforeRestart);
  });

  it("suppresses progress when successful MCP logs arrive before or after its candidate, regardless of idle ordering", async () => {
    const enqueue = vi.fn<TrackingQueue["enqueue"]>().mockResolvedValue(true);
    const store = createSessionStore();
    const tracker = createTurnTracker(store, { queue: queue(enqueue), worker: { signal: vi.fn() } });
    const state = store.get("s-1");
    state.attachedTaskId = "task-1";
    const transition = () => applyToolExecuteAfter(state, {
      tool: "mcp_Ai-task-tracker_transition_task_status",
      args: { task_id: "task-1", status: "TO_REVIEW" },
      outputText: JSON.stringify({ id: "task-1", status: "TO_REVIEW" }),
    });
    const log = () => applyToolExecuteAfter(state, {
      tool: "mcp_Ai-task-tracker_add_task_log",
      args: { task_id: "task-1" },
      outputText: JSON.stringify({ id: "log-1", task_id: "task-1", author: "agent", message: "done", created_at: "2026-09-10T00:00:00.000Z" }),
    });

    tracker.onChatMessage({ sessionID: "s-1", messageID: "before" });
    log();
    transition();
    await tracker.onSessionIdle("s-1");
    tracker.onChatMessage({ sessionID: "s-1", messageID: "after" });
    transition();
    log();
    await tracker.onSessionIdle("s-1");

    expect(enqueue.mock.calls.map(([event]) => event.kind)).not.toContain("response-progress");
  });

  it("persists a confirmed attachment as delivery-ineligible until that session becomes idle", async () => {
    const enqueue = vi.fn<TrackingQueue["enqueue"]>().mockResolvedValue(true);
    const signal = vi.fn();
    const store = createSessionStore();
    const tracker = createTurnTracker(store, { queue: queue(enqueue), worker: { signal }, author: "configured-agent" });
    tracker.onCommandExecuteBefore({ command: "tt", sessionID: "s-1", arguments: "TASK-42" });
    tracker.onChatMessage({ sessionID: "s-1", messageID: "m-1" });
    successfulGetTask(store.get("s-1"), "TASK-42");

    await tracker.confirmPendingAttachment("s-1");

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ deliveryEligible: false, author: "configured-agent" }));
    expect(signal).not.toHaveBeenCalled();
  });
});

function trackerFor(store: ReturnType<typeof createSessionStore>) {
  return createTurnTracker(store, { queue: queue(), worker: { signal: vi.fn() } });
}
