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

import plugin from "./ai-task-tracker-nudge";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakeContext {
  sessionManager: { getSessionId(): string };
}

interface FakeToolResult {
  content: { type: "text"; text: string }[];
}

interface FakeToolDefinition {
  name: string;
  execute(
    toolCallId: string,
    params: { task_id: string },
    signal: undefined,
    onUpdate: undefined,
    ctx: FakeContext,
  ): Promise<FakeToolResult>;
}

function queue(
  enqueue: TrackingQueue["enqueue"] = async () => true,
  markDeliveryEligible: TrackingQueue["markDeliveryEligible"] = async () => true,
): TrackingQueue {
  return {
    enqueue,
    dueAt: async () => [],
    removeDelivered: async () => false,
    markRetry: async () => false,
    markTerminal: async () => false,
    markDeliveryEligible,
  };
}

function enabledConfig() {
  return {
    enabled: true as const,
    baseUrl: "https://tracker.example",
    apiKey: "secret-key",
    queuePath: "/tmp/tracker.json",
    author: "omp",
  };
}

/** Minimal Zod-compatible stand-in: only what `.registerTool`'s schema needs at call time. */
function fakeZod() {
  const stringSchema = { min: () => stringSchema };
  return { object: (shape: Record<string, unknown>) => ({ shape }), string: () => stringSchema };
}

function createApi() {
  const handlers: Record<string, Handler> = {};
  let registeredTool: FakeToolDefinition | undefined;
  const api = {
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    zod: fakeZod(),
    on: vi.fn((event: string, handler: Handler) => {
      handlers[event] = handler;
    }),
    registerTool: vi.fn((tool: FakeToolDefinition) => {
      registeredTool = tool;
    }),
  };
  return {
    api,
    handlers,
    tool(): FakeToolDefinition {
      if (!registeredTool) throw new Error("tool was not registered");
      return registeredTool;
    },
  };
}

function ctxFor(sessionId: string): FakeContext {
  return { sessionManager: { getSessionId: () => sessionId } };
}

async function setup() {
  const harness = createApi();
  await plugin(harness.api as never);
  return harness;
}

function toolResultEvent(overrides: { toolName: string; input?: Record<string, unknown>; content?: unknown[]; isError?: boolean }) {
  return {
    type: "tool_result",
    toolCallId: "call-1",
    input: {},
    content: [],
    details: undefined,
    isError: false,
    ...overrides,
  };
}

describe("AI Task Tracker omp extension", () => {
  beforeEach(() => {
    mocks.readTrackerConfig.mockReset();
    mocks.openTrackingQueue.mockReset();
    mocks.start.mockClear();
    mocks.stop.mockClear();
    mocks.signal.mockClear();
    mocks.openTrackingQueue.mockResolvedValue(queue());
  });

  it("registers the required extension hooks and tool, and starts the delivery worker", async () => {
    mocks.readTrackerConfig.mockReturnValue(enabledConfig());
    const { api, handlers, tool } = await setup();

    for (const event of ["agent_start", "before_agent_start", "tool_result", "agent_end", "session_shutdown"]) {
      expect(handlers[event]).toBeInstanceOf(Function);
    }
    expect(api.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "task_tracker_mark_attachment_candidate", execute: expect.any(Function) }),
    );
    expect(tool()).toBeDefined();
    expect(mocks.start).toHaveBeenCalledOnce();

    await handlers.session_shutdown(undefined, ctxFor("s-1"));
    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it("injects the session id note on every prompt and consumes a pending reminder once", async () => {
    mocks.readTrackerConfig.mockReturnValue(enabledConfig());
    const { handlers } = await setup();

    const first = await handlers.before_agent_start({ systemPrompt: ["base prompt"] }, ctxFor("s-1"));
    expect(first).toEqual({ systemPrompt: ["base prompt", "## AI Task Tracker session\nCurrent omp session id: s-1"] });

    const second = await handlers.before_agent_start({ systemPrompt: ["base prompt"] }, ctxFor("s-1"));
    expect(second).toEqual({ systemPrompt: ["base prompt", "## AI Task Tracker session\nCurrent omp session id: s-1"] });
  });

  it("queues one attachment only after a same-session successful get_task and the marker tool", async () => {
    const enqueue = vi.fn<TrackingQueue["enqueue"]>().mockResolvedValue(true);
    mocks.readTrackerConfig.mockReturnValue(enabledConfig());
    mocks.openTrackingQueue.mockResolvedValue(queue(enqueue, async (sessionId) => sessionId === "s-1"));
    const { handlers, tool } = await setup();

    await handlers.tool_result(
      toolResultEvent({
        toolName: "mcp__ai_task_tracker_get_task",
        input: { task_id: "TASK-1" },
        content: [{ type: "text", text: JSON.stringify({ id: "TASK-1", status: "TO_DO" }) }],
      }),
      ctxFor("s-1"),
    );

    const result = await tool().execute("call-1", { task_id: "TASK-1" }, undefined, undefined, ctxFor("s-1"));
    expect(result).toEqual({ content: [{ type: "text", text: "Attachment candidate queued." }] });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ taskId: "TASK-1", kind: "task-attached" }));

    const second = await tool().execute("call-2", { task_id: "TASK-1" }, undefined, undefined, ctxFor("s-1"));
    expect(second).toEqual({ content: [{ type: "text", text: "No verified attachment candidate to queue." }] });
  });

  it("ignores an errored get_task tool_result for attachment validation", async () => {
    const enqueue = vi.fn<TrackingQueue["enqueue"]>().mockResolvedValue(true);
    mocks.readTrackerConfig.mockReturnValue(enabledConfig());
    mocks.openTrackingQueue.mockResolvedValue(queue(enqueue));
    const { handlers, tool } = await setup();

    await handlers.tool_result(
      toolResultEvent({
        toolName: "mcp__ai_task_tracker_get_task",
        input: { task_id: "TASK-1" },
        content: [{ type: "text", text: JSON.stringify({ id: "TASK-1", status: "TO_DO" }) }],
        isError: true,
      }),
      ctxFor("s-1"),
    );

    const result = await tool().execute("call-1", { task_id: "TASK-1" }, undefined, undefined, ctxFor("s-1"));
    expect(result).toEqual({ content: [{ type: "text", text: "No verified attachment candidate to queue." }] });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects validated markers for another task or another session", async () => {
    const enqueue = vi.fn<TrackingQueue["enqueue"]>().mockResolvedValue(true);
    mocks.readTrackerConfig.mockReturnValue(enabledConfig());
    mocks.openTrackingQueue.mockResolvedValue(queue(enqueue));
    const { handlers, tool } = await setup();

    await handlers.tool_result(
      toolResultEvent({
        toolName: "mcp__ai_task_tracker_get_task",
        input: { task_id: "TASK-1" },
        content: [{ type: "text", text: JSON.stringify({ id: "TASK-1", status: "TO_DO" }) }],
      }),
      ctxFor("s-1"),
    );

    await expect(tool().execute("call-1", { task_id: "TASK-2" }, undefined, undefined, ctxFor("s-1"))).resolves.toEqual({
      content: [{ type: "text", text: "No verified attachment candidate to queue." }],
    });
    await expect(tool().execute("call-2", { task_id: "TASK-1" }, undefined, undefined, ctxFor("s-2"))).resolves.toEqual({
      content: [{ type: "text", text: "No verified attachment candidate to queue." }],
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("waits for its session to become idle before signaling an ineligible attachment", async () => {
    const enqueue = vi.fn<TrackingQueue["enqueue"]>().mockResolvedValue(true);
    mocks.readTrackerConfig.mockReturnValue(enabledConfig());
    mocks.openTrackingQueue.mockResolvedValue(queue(enqueue, async (sessionId) => sessionId === "s-1"));
    const { handlers, tool } = await setup();

    await handlers.tool_result(
      toolResultEvent({
        toolName: "mcp__ai_task_tracker_get_task",
        input: { task_id: "TASK-1" },
        content: [{ type: "text", text: JSON.stringify({ id: "TASK-1", status: "TO_DO" }) }],
      }),
      ctxFor("s-1"),
    );
    await tool().execute("call-1", { task_id: "TASK-1" }, undefined, undefined, ctxFor("s-1"));

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ deliveryEligible: false }));
    expect(mocks.signal).not.toHaveBeenCalled();

    await handlers.agent_end({ type: "agent_end", messages: [] }, ctxFor("s-1"));
    expect(mocks.signal).toHaveBeenCalledOnce();
  });

  it("delivers only for its own session on agent_end", async () => {
    const enqueue = vi.fn<TrackingQueue["enqueue"]>().mockResolvedValue(true);
    mocks.readTrackerConfig.mockReturnValue(enabledConfig());
    mocks.openTrackingQueue.mockResolvedValue(queue(enqueue, async (sessionId) => sessionId === "s-1"));
    const { handlers, tool } = await setup();

    await handlers.tool_result(
      toolResultEvent({
        toolName: "mcp__ai_task_tracker_get_task",
        input: { task_id: "TASK-1" },
        content: [{ type: "text", text: JSON.stringify({ id: "TASK-1", status: "TO_DO" }) }],
      }),
      ctxFor("s-1"),
    );
    await tool().execute("call-1", { task_id: "TASK-1" }, undefined, undefined, ctxFor("s-1"));

    await handlers.agent_end({ type: "agent_end", messages: [] }, ctxFor("s-2"));
    expect(mocks.signal).not.toHaveBeenCalled();

    await handlers.agent_end({ type: "agent_end", messages: [] }, ctxFor("s-1"));
    expect(mocks.signal).toHaveBeenCalledOnce();
  });

  it("does not finalize the turn or evaluate reminders when the agent loop will continue", async () => {
    mocks.readTrackerConfig.mockReturnValue(enabledConfig());
    const markDeliveryEligible = vi.fn<TrackingQueue["markDeliveryEligible"]>().mockResolvedValue(true);
    mocks.openTrackingQueue.mockResolvedValue(queue(async () => true, markDeliveryEligible));
    const { handlers } = await setup();

    await handlers.agent_end({ type: "agent_end", messages: [], willContinue: true }, ctxFor("s-1"));
    expect(markDeliveryEligible).not.toHaveBeenCalled();
    expect(mocks.signal).not.toHaveBeenCalled();
  });

  it("injects and consumes disabled-logging lifecycle reminders as system-prompt text", async () => {
    mocks.readTrackerConfig.mockReturnValue({
      enabled: false,
      diagnostic: "AI Task Tracker automatic logging disabled.",
    });
    const { api, handlers } = await setup();
    expect(api.logger.warn).toHaveBeenCalledWith("AI Task Tracker automatic logging disabled.");

    await handlers.tool_result(
      toolResultEvent({
        toolName: "mcp__ai_task_tracker_get_task",
        input: { task_id: "TASK-1" },
        content: [{ type: "text", text: JSON.stringify({ id: "TASK-1", status: "TO_AGENT" }) }],
      }),
      ctxFor("s-1"),
    );
    await handlers.tool_result(
      toolResultEvent({
        toolName: "bash",
        input: { command: "git commit -m done" },
        content: [{ type: "text", text: "" }],
      }),
      ctxFor("s-1"),
    );
    await handlers.agent_end({ type: "agent_end", messages: [] }, ctxFor("s-1"));

    const first = await handlers.before_agent_start({ systemPrompt: [] }, ctxFor("s-1"));
    expect(first).toEqual({
      systemPrompt: [
        "## AI Task Tracker session\nCurrent omp session id: s-1",
        "## AI Task Tracker reminder\nA commit was made on this task. Consider transition_task_status to TO_REVIEW.",
      ],
    });

    const second = await handlers.before_agent_start({ systemPrompt: [] }, ctxFor("s-1"));
    expect(second).toEqual({ systemPrompt: ["## AI Task Tracker session\nCurrent omp session id: s-1"] });
  });
});
