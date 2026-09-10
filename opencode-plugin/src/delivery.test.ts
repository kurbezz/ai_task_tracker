import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TrackerConfig } from "./config";
import {
  TrackingDeliveryWorker,
  type DeliveryDependencies,
} from "./delivery";
import { openTrackingQueue, type TrackingEvent, type TrackingQueue } from "./queue";
import { createSessionStore } from "./state";
import { createTurnTracker, markPendingAttachmentConfirmable } from "./turns";

const now = new Date("2026-09-09T12:00:00.000Z");
const MAX_TIMER_DELAY_MS = 2_147_483_647;

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function event(overrides: Partial<TrackingEvent> = {}): TrackingEvent {
  return {
    idempotencyKey: "opencode:s-1:response-progress:m-1",
    sessionId: "s-1",
    eventId: "response-progress:m-1",
    taskId: "task-1",
    kind: "response-progress",
    author: "opencode",
    message: "Updated task task-1 status to TO_REVIEW.",
    createdAt: now.toISOString(),
    attempts: 0,
    nextAttemptAt: now.toISOString(),
    deliveryEligible: true,
    ...overrides,
  };
}

function config(): TrackerConfig {
  return {
    enabled: true,
    baseUrl: "https://tracker.example///",
    apiKey: "secret-key",
    queuePath: "/unused/queue.json",
    author: "opencode",
  };
}

function memoryQueue(events: TrackingEvent[] = []): TrackingQueue {
  const pending = [...events];
  return {
    enqueue: async (queued) => {
      if (pending.some((item) => item.idempotencyKey === queued.idempotencyKey)) return false;
      pending.push({ ...queued });
      return true;
    },
    dueAt: async (at) => pending.filter((item) => item.nextAttemptAt <= at).map((item) => ({ ...item })),
    removeDelivered: async (key) => {
      const index = pending.findIndex((item) => item.idempotencyKey === key);
      if (index < 0) return false;
      pending.splice(index, 1);
      return true;
    },
    markRetry: async (key, attempts, nextAttemptAt) => {
      const item = pending.find((candidate) => candidate.idempotencyKey === key);
      if (!item) return false;
      item.attempts = attempts;
      item.nextAttemptAt = nextAttemptAt;
      return true;
    },
    markTerminal: async (key) => {
      const index = pending.findIndex((item) => item.idempotencyKey === key);
      if (index < 0) return false;
      pending.splice(index, 1);
      return true;
    },
    markDeliveryEligible: async () => false,
  };
}

function worker(
  queue: TrackingQueue,
  fetchMock = vi.fn<typeof fetch>(),
  overrides: Partial<DeliveryDependencies> = {},
): TrackingDeliveryWorker {
  return new TrackingDeliveryWorker(config(), {
    fetch: fetchMock,
    openQueue: async () => queue,
    now: () => new Date(now),
    random: () => 0.5,
    setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => undefined,
    ...overrides,
  });
}

describe("TrackingDeliveryWorker", () => {
  it("posts the exact authenticated task-log request", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 201 }));
    const delivery = worker(memoryQueue(), fetchMock);

    await delivery.deliver(event());

    expect(fetchMock).toHaveBeenCalledWith(
      "https://tracker.example/api/tasks/task-1/logs",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Api-Key": "secret-key",
          "Content-Type": "application/json",
          "Idempotency-Key": "opencode:s-1:response-progress:m-1",
        }),
        body: JSON.stringify({ author: "opencode", message: "Updated task task-1 status to TO_REVIEW." }),
        signal: expect.any(AbortSignal),
        redirect: "error",
      }),
    );
  });

  it("posts a custom configured event author unchanged", async () => {
    const queued = event({ author: "configured-agent" as TrackingEvent["author"] });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 201 }));

    await worker(memoryQueue([queued]), fetchMock).deliver(queued);

    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      body: JSON.stringify({ author: "configured-agent", message: queued.message }),
    }));
  });

  it.each([200, 201, 204, 299])("removes an event for HTTP %i", async (status) => {
    const queued = event();
    const queue = memoryQueue([queued]);
    const delivery = worker(queue, vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status })));

    await delivery.deliver(queued);

    await expect(queue.dueAt(now.toISOString())).resolves.toEqual([]);
  });

  it.each([400, 401, 403, 404, 422])("dead-letters HTTP %i without rescheduling", async (status) => {
    const queued = event();
    const queue = memoryQueue([queued]);
    const setTimeout = vi.fn();
    const delivery = worker(queue, vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status })), { setTimeout });

    await delivery.deliver(queued);

    await expect(queue.dueAt(now.toISOString())).resolves.toEqual([]);
    expect(setTimeout).not.toHaveBeenCalled();
  });

  it.each([429, 500, 503, 599])("persists a retry for retryable HTTP %i", async (status) => {
    const queued = event();
    const queue = memoryQueue([queued]);
    const setTimeout = vi.fn();
    const delivery = worker(queue, vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status })), { setTimeout });

    await delivery.deliver(queued);

    await expect(queue.dueAt(new Date(now.getTime() + 1_000).toISOString())).resolves.toEqual([
      { ...queued, attempts: 1, nextAttemptAt: new Date(now.getTime() + 1_000).toISOString() },
    ]);
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 1_000);
  });

  it("retries network and abort failures", async () => {
    for (const failure of [new Error("network unavailable"), new DOMException("Timed out", "AbortError")]) {
      const queued = event();
      const queue = memoryQueue([queued]);
      const delivery = worker(queue, vi.fn<typeof fetch>().mockRejectedValue(failure));

      await delivery.deliver(queued);

      await expect(queue.dueAt(new Date(now.getTime() + 1_000).toISOString())).resolves.toHaveLength(1);
    }
  });

  it("honors a delta-seconds Retry-After exactly", async () => {
    const queued = event();
    const queue = memoryQueue([queued]);
    const setTimeout = vi.fn();
    const delivery = worker(
      queue,
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429, headers: { "Retry-After": "17" } })),
      { setTimeout },
    );

    await delivery.deliver(queued);

    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 17_000);
    await expect(queue.dueAt(new Date(now.getTime() + 17_000).toISOString())).resolves.toHaveLength(1);
  });

  it("persists a large Retry-After while capping and rechecking its timer", async () => {
    const queued = event();
    const queue = memoryQueue([queued]);
    const callbacks: Array<() => void> = [];
    const setTimeout = vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return 1 as unknown as ReturnType<typeof globalThis.setTimeout>;
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 429, headers: { "Retry-After": "3000000" } }),
    );
    const delivery = worker(queue, fetchMock, { setTimeout });

    await delivery.deliver(queued);

    const dueAt = new Date(now.getTime() + 3_000_000_000).toISOString();
    await expect(queue.dueAt(dueAt)).resolves.toEqual([{ ...queued, attempts: 1, nextAttemptAt: dueAt }]);
    expect(setTimeout).toHaveBeenLastCalledWith(expect.any(Function), MAX_TIMER_DELAY_MS);

    callbacks[0]();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(setTimeout).toHaveBeenLastCalledWith(expect.any(Function), MAX_TIMER_DELAY_MS);
  });

  it("uses exponential backoff with jitter and a 300-second cap", async () => {
    const queue = memoryQueue();
    const setTimeout = vi.fn();
    const delivery = worker(queue, vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")), { setTimeout });

    for (const attempts of [0, 1, 2, 20]) {
      await delivery.deliver(event({ idempotencyKey: `key-${attempts}`, attempts }));
    }

    expect(setTimeout.mock.calls.map(([, delay]) => delay)).toEqual([1_000, 2_000, 4_000, 300_000]);
  });

  it("recovers existing queue entries on start and prevents concurrent delivery of one event", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    const queued = event();
    const delivery = worker(memoryQueue([queued]), fetchMock);

    await delivery.start();
    await Promise.resolve();
    delivery.signal();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch?.(new Response(null, { status: 200 }));
    await Promise.resolve();
    await Promise.resolve();
  });

  it("does not deliver staged attachments after restart or another session's idle", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tracking-delivery-"));
    const queuePath = path.join(directory, "queue.json");
    const trackerConfig = { ...config(), queuePath };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 201 }));
    try {
      const firstWorker = new TrackingDeliveryWorker(trackerConfig, { fetch: fetchMock });
      await firstWorker.start();
      const activeStore = createSessionStore();
      const activeTracker = createTurnTracker(activeStore, {
        queue: await openTrackingQueue(queuePath), worker: firstWorker, author: "configured-agent",
      });
      for (const sessionID of ["s-1", "s-2"]) {
        activeTracker.onCommandExecuteBefore({ command: "tt", sessionID, arguments: `TASK-${sessionID}` });
        activeTracker.onChatMessage({ sessionID, messageID: `m-${sessionID}` });
        markPendingAttachmentConfirmable(activeStore.get(sessionID), `TASK-${sessionID}`);
        await activeTracker.confirmPendingAttachment(sessionID);
      }
      await settle();
      expect(fetchMock).not.toHaveBeenCalled();

      firstWorker.stop();
      const restartedWorker = new TrackingDeliveryWorker(trackerConfig, { fetch: fetchMock });
      await restartedWorker.start();
      await settle();
      expect(fetchMock).not.toHaveBeenCalled();

      const recoveredTracker = createTurnTracker(createSessionStore(), {
        queue: await openTrackingQueue(queuePath), worker: restartedWorker, author: "configured-agent",
      });
      await recoveredTracker.onSessionIdle("s-3");
      await settle();
      expect(fetchMock).not.toHaveBeenCalled();
      await recoveredTracker.onSessionIdle("s-1");
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      await recoveredTracker.onSessionIdle("s-2");
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      restartedWorker.stop();
    } finally {
      await fs.rm(directory, { force: true, recursive: true });
    }
  });

  it("replays after a crash with the same idempotency key", async () => {
    const queued = event();
    const acceptedKeys = new Set<string>();
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      acceptedKeys.add((init?.headers as Record<string, string>)["Idempotency-Key"]);
      return new Response(null, { status: 201 });
    });
    const failingQueue: TrackingQueue = { ...memoryQueue([queued]), removeDelivered: async () => { throw new Error("disk full"); } };

    await expect(worker(failingQueue, fetchMock).deliver(queued)).rejects.toThrow("disk full");
    await worker(memoryQueue([queued]), fetchMock).deliver(queued);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(acceptedKeys).toEqual(new Set([queued.idempotencyKey]));
  });

  it("retains an acknowledged event and schedules a rescan when its removal cannot be persisted", async () => {
    const queued = event();
    const setTimeout = vi.fn();
    const queue: TrackingQueue = {
      ...memoryQueue([queued]),
      removeDelivered: async () => { throw new Error("disk full"); },
    };
    const delivery = worker(queue, vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 201 })), { setTimeout });

    await expect(delivery.deliver(queued)).rejects.toThrow("disk full");

    await expect(queue.dueAt(now.toISOString())).resolves.toEqual([queued]);
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 1_000);
  });

  it.each([
    [500, "markRetry"],
    [400, "markTerminal"],
  ] as const)("retains and schedules a bounded rescan when %s response %s cannot be persisted", async (status, mutation) => {
    const queued = event();
    const setTimeout = vi.fn();
    const queue: TrackingQueue = {
      ...memoryQueue([queued]),
      [mutation]: async () => { throw new Error("disk full"); },
    };

    await expect(worker(queue, vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status })), { setTimeout }).deliver(queued))
      .rejects.toThrow("disk full");

    await expect(queue.dueAt(now.toISOString())).resolves.toEqual([queued]);
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 1_000);
  });

  it("sanitizes failures from detached recovery, signal, and timer delivery", async () => {
    const diagnostic = vi.fn();
    const unavailableQueue: TrackingQueue = {
      ...memoryQueue(),
      dueAt: async () => { throw new Error("https://secret.example/private"); },
    };
    const recovering = worker(unavailableQueue, vi.fn<typeof fetch>(), { diagnostic });
    await recovering.start();
    await settle();

    const queued = event();
    const mutationFailure: TrackingQueue = {
      ...memoryQueue([queued]),
      removeDelivered: async () => { throw new Error("private event body"); },
    };
    const signaling = worker(mutationFailure, vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 })), { diagnostic });
    signaling.signal();
    await settle();

    let current = new Date(now);
    const callbacks: Array<() => void> = [];
    const retryFailure: TrackingQueue = {
      ...memoryQueue([event({ nextAttemptAt: new Date(now.getTime() + 1_000).toISOString() })]),
      markRetry: async () => { throw new Error("private retry failure"); },
    };
    const timer = worker(
      retryFailure,
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 500 })),
      {
        diagnostic,
        now: () => new Date(current),
        setTimeout: (callback) => {
          callbacks.push(callback);
          return 1 as unknown as ReturnType<typeof globalThis.setTimeout>;
        },
      },
    );
    await timer.start();
    await settle();
    current = new Date(now.getTime() + 1_000);
    callbacks[0]();
    await settle();

    expect(diagnostic).toHaveBeenCalled();
    expect(diagnostic.mock.calls.flat().join(" ")).not.toContain("secret.example");
    expect(diagnostic.mock.calls.flat().join(" ")).not.toContain("private event body");
    expect(diagnostic.mock.calls.flat().join(" ")).not.toContain("private retry failure");
  });

  it("does not schedule retries after disposal while delivery is in flight", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const setTimeout = vi.fn();
    const queued = event();
    const delivery = worker(
      memoryQueue([queued]),
      vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })),
      { setTimeout },
    );

    const pending = delivery.deliver(queued);
    delivery.dispose();
    resolveFetch?.(new Response(null, { status: 500 }));
    await pending;

    expect(setTimeout).not.toHaveBeenCalled();
  });

  it("does not put request secrets or bodies in diagnostics", async () => {
    const diagnostic = vi.fn();
    const queued = event({ message: "private event body" });
    await worker(memoryQueue([queued]), vi.fn<typeof fetch>().mockResolvedValue(new Response("secret server body", { status: 400 })), { diagnostic }).deliver(queued);

    expect(diagnostic.mock.calls.flat().join(" ")).not.toContain("secret-key");
    expect(diagnostic.mock.calls.flat().join(" ")).not.toContain("private event body");
    expect(diagnostic.mock.calls.flat().join(" ")).not.toContain("secret server body");
  });
});
