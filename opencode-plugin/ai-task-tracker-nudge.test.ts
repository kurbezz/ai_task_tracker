import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackingQueue } from "./src/queue";

const mocks = vi.hoisted(() => {
  const start = vi.fn(async () => undefined);
  const stop = vi.fn();
  const signal = vi.fn();
  return {
    readTrackerConfig: vi.fn(),
    openTrackingQueue: vi.fn(),
    start,
    stop,
    signal,
  };
});

vi.mock("./src/config", () => ({ readTrackerConfig: mocks.readTrackerConfig }));
vi.mock("./src/queue", () => ({ openTrackingQueue: mocks.openTrackingQueue }));
vi.mock("./src/delivery", () => ({
  TrackingDeliveryWorker: class {
    start = mocks.start;
    stop = mocks.stop;
    signal = mocks.signal;
  },
}));
import AiTaskTrackerNudge from "./ai-task-tracker-nudge";

function queue(enqueue: TrackingQueue["enqueue"] = async () => true): TrackingQueue {
  return {
    enqueue,
    dueAt: async () => [],
    removeDelivered: async () => false,
    markRetry: async () => false,
    markTerminal: async () => false,
    markDeliveryEligible: async () => true,
  };
}

function enabledConfig() {
  return {
    enabled: true as const,
    baseUrl: "https://tracker.example",
    apiKey: "secret-key",
    queuePath: "/tmp/tracker.json",
    author: "opencode",
  };
}

describe("AiTaskTrackerNudge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.openTrackingQueue.mockResolvedValue(queue());
  });

  it("loads enabled configuration once, starts durable delivery, and wires supported hooks", async () => {
    mocks.readTrackerConfig.mockReturnValue(enabledConfig());

    const hooks = await AiTaskTrackerNudge({} as never);

    expect(mocks.readTrackerConfig).toHaveBeenCalledOnce();
    expect(mocks.openTrackingQueue).toHaveBeenCalledWith("/tmp/tracker.json");
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(hooks).toEqual(expect.objectContaining({
      "chat.message": expect.any(Function),
      "command.execute.before": expect.any(Function),
      "tool.execute.after": expect.any(Function),
      tool: expect.objectContaining({ task_tracker_mark_attachment_candidate: expect.any(Object) }),
      event: expect.any(Function),
      "experimental.chat.system.transform": expect.any(Function),
      dispose: expect.any(Function),
    }));

    await hooks["command.execute.before"]?.({ command: "tt", sessionID: "s-1", arguments: "TASK-1" }, {} as never);
    await hooks["chat.message"]?.({ sessionID: "s-1", messageID: "m-1" }, {} as never);
    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s-1" } } as never });

    await hooks.dispose?.();
    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it("keeps tracker status observation and lifecycle nudges usable while logging is disabled", async () => {
    mocks.readTrackerConfig.mockReturnValue({
      enabled: false,
      diagnostic: "AI Task Tracker automatic logging disabled: AI_TRACKER_URL are required.",
    });
    const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const hooks = await AiTaskTrackerNudge({} as never);
    await hooks["tool.execute.after"]?.({
      tool: "mcp_ai-task-tracker_transition_task_status",
      sessionID: "s-1",
      callID: "c-1",
      args: { status: "TO_AGENT" },
    }, { output: "{}" } as never);
    await hooks["tool.execute.after"]?.({
      tool: "bash",
      sessionID: "s-1",
      callID: "c-2",
      args: { command: "git commit -m done" },
    }, { output: "" } as never);
    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s-1" } } as never });

    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]?.({ sessionID: "s-1" } as never, output);

    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledWith(expect.not.stringContaining("secret-key"));
    expect(mocks.openTrackingQueue).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(output.system).toEqual([
      "## AI Task Tracker session\nCurrent opencode session id: s-1",
      "## AI Task Tracker reminder\nThis session has made changes but has no linked AI Task Tracker task yet. Consider calling create_task (or confirm to the user that no task is needed for this work).",
    ]);
    expect(output.system.join("\n")).not.toContain("add_task_log");

    diagnostic.mockRestore();
  });

  it("queues one verified attachment only after the custom marker, without tracker logging before idle", async () => {
    const enqueue = vi.fn<TrackingQueue["enqueue"]>().mockResolvedValue(true);
    mocks.readTrackerConfig.mockReturnValue(enabledConfig());
    mocks.openTrackingQueue.mockResolvedValue(queue(enqueue));
    const hooks = await AiTaskTrackerNudge({} as never);

    await hooks["command.execute.before"]?.({ command: "tt", sessionID: "s-1", arguments: "TASK-1" }, {} as never);
    await hooks["chat.message"]?.({ sessionID: "s-1", messageID: "m-1" }, {} as never);
    await hooks["tool.execute.after"]?.({
      tool: "mcp_ai-task-tracker_get_task",
      sessionID: "s-1",
      callID: "get-1",
      args: { task_id: "TASK-1" },
    }, { output: JSON.stringify({ id: "TASK-1", status: "TO_DO" }) } as never);

    expect(enqueue).not.toHaveBeenCalled();
    await expect(hooks.tool?.task_tracker_mark_attachment_candidate.execute({}, { sessionID: "s-1" } as never))
      .resolves.toBe("Attachment candidate queued.");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "TASK-1",
      kind: "task-attached",
      author: "opencode",
    }));

    expect(mocks.signal).not.toHaveBeenCalled();
    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s-1" } } as never });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.signal).toHaveBeenCalledOnce();
  });

  it("does not let one session's idle signal another session's staged attachment", async () => {
    const enqueue = vi.fn<TrackingQueue["enqueue"]>().mockResolvedValue(true);
    mocks.readTrackerConfig.mockReturnValue(enabledConfig());
    mocks.openTrackingQueue.mockResolvedValue(queue(enqueue));
    const hooks = await AiTaskTrackerNudge({} as never);

    for (const sessionID of ["s-1", "s-2"]) {
      await hooks["command.execute.before"]?.({ command: "tt", sessionID, arguments: `TASK-${sessionID}` }, {} as never);
      await hooks["chat.message"]?.({ sessionID, messageID: `m-${sessionID}` }, {} as never);
      await hooks["tool.execute.after"]?.({ tool: "mcp_ai-task-tracker_get_task", sessionID, callID: `get-${sessionID}`, args: { task_id: `TASK-${sessionID}` } }, { output: JSON.stringify({ id: `TASK-${sessionID}`, status: "TO_DO" }) } as never);
      await hooks.tool?.task_tracker_mark_attachment_candidate.execute({}, { sessionID } as never);
    }

    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s-1" } } as never });
    expect(mocks.signal).toHaveBeenCalledTimes(1);
    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s-2" } } as never });
    expect(mocks.signal).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["malformed", "not json"],
    ["failed", JSON.stringify({ id: "TASK-1", status: "TO_DO", error: "not found" })],
  ])("refuses the attachment marker after a %s get_task result", async (_case, output) => {
    const enqueue = vi.fn<TrackingQueue["enqueue"]>().mockResolvedValue(true);
    mocks.readTrackerConfig.mockReturnValue(enabledConfig());
    mocks.openTrackingQueue.mockResolvedValue(queue(enqueue));
    const hooks = await AiTaskTrackerNudge({} as never);

    await hooks["command.execute.before"]?.({ command: "tt", sessionID: "s-1", arguments: "TASK-1" }, {} as never);
    await hooks["chat.message"]?.({ sessionID: "s-1", messageID: "m-1" }, {} as never);
    await hooks["tool.execute.after"]?.({
      tool: "mcp_ai-task-tracker_get_task",
      sessionID: "s-1",
      callID: "get-1",
      args: { task_id: "TASK-1" },
    }, { output } as never);

    await expect(hooks.tool?.task_tracker_mark_attachment_candidate.execute({}, { sessionID: "s-1" } as never))
      .resolves.toBe("No verified attachment candidate to queue.");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("keeps session context and lifecycle reminders working when queue setup or confirmation fails", async () => {
    mocks.readTrackerConfig.mockReturnValue(enabledConfig());
    mocks.openTrackingQueue.mockRejectedValue(new Error("queue unavailable"));
    const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hooks = await AiTaskTrackerNudge({} as never);

    await hooks["chat.message"]?.({ sessionID: "s-1", messageID: "m-1" }, {} as never);
    await hooks["tool.execute.after"]?.({
      tool: "mcp_ai-task-tracker_get_task",
      sessionID: "s-1",
      callID: "get-1",
      args: { task_id: "TASK-1" },
    }, { output: JSON.stringify({ id: "TASK-1", status: "TO_AGENT" }) } as never);
    await hooks["tool.execute.after"]?.({
      tool: "bash",
      sessionID: "s-1",
      callID: "commit-1",
      args: { command: "git commit -m done" },
    }, { output: "" } as never);
    await expect(hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s-1" } } as never })).resolves.toBeUndefined();

    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]?.({ sessionID: "s-1" } as never, output);
    expect(output.system).toEqual([
      "## AI Task Tracker session\nCurrent opencode session id: s-1",
      "## AI Task Tracker reminder\nA commit was made on this task. Consider transition_task_status to TO_REVIEW.",
    ]);
    expect(diagnostic).toHaveBeenCalledWith("AI Task Tracker automatic logging unavailable; continuing without direct logging.");
    diagnostic.mockRestore();
  });

  it("contains attachment queue failures and still stages lifecycle reminders", async () => {
    const enqueue = vi.fn<TrackingQueue["enqueue"]>().mockRejectedValue(new Error("disk full"));
    mocks.readTrackerConfig.mockReturnValue(enabledConfig());
    mocks.openTrackingQueue.mockResolvedValue(queue(enqueue));
    const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hooks = await AiTaskTrackerNudge({} as never);

    await hooks["command.execute.before"]?.({ command: "tt", sessionID: "s-1", arguments: "TASK-1" }, {} as never);
    await hooks["chat.message"]?.({ sessionID: "s-1", messageID: "m-1" }, {} as never);
    await hooks["tool.execute.after"]?.({
      tool: "mcp_ai-task-tracker_get_task",
      sessionID: "s-1",
      callID: "get-1",
      args: { task_id: "TASK-1" },
    }, { output: JSON.stringify({ id: "TASK-1", status: "TO_AGENT" }) } as never);
    await hooks["tool.execute.after"]?.({
      tool: "bash",
      sessionID: "s-1",
      callID: "commit-1",
      args: { command: "git commit -m done" },
    }, { output: "" } as never);

    await expect(hooks.tool?.task_tracker_mark_attachment_candidate.execute({}, { sessionID: "s-1" } as never))
      .resolves.toBe("Attachment candidate could not be queued.");
    await expect(hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s-1" } } as never })).resolves.toBeUndefined();

    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]?.({ sessionID: "s-1" } as never, output);
    expect(output.system).toEqual(expect.arrayContaining([
      "## AI Task Tracker reminder\nA commit was made on this task. Consider transition_task_status to TO_REVIEW.",
    ]));
    expect(diagnostic).toHaveBeenCalledWith("AI Task Tracker attachment candidate could not be queued.");
    diagnostic.mockRestore();
  });
});
