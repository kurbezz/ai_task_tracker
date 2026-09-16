import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openTrackingQueue, type TrackingEvent } from "./queue";

const now = "2026-09-09T12:00:00.000Z";
const later = "2026-09-09T12:01:00.000Z";
const directories: string[] = [];

function event(overrides: Partial<TrackingEvent> = {}): TrackingEvent {
  return {
    idempotencyKey: "opencode:s-1:response-progress:m-1",
    sessionId: "s-1",
    eventId: "response-progress:m-1",
    taskId: "task-1",
    kind: "response-progress",
    author: "opencode",
    message: "Updated task task-1 status to TO_REVIEW.",
    createdAt: now,
    attempts: 0,
    nextAttemptAt: now,
    deliveryEligible: true,
    ...overrides,
  };
}

async function queuePath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tracking-queue-"));
  directories.push(directory);
  return path.join(directory, "queue.json");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

describe("openTrackingQueue", () => {
  it("durably enqueues an event once and reloads it after reopening", async () => {
    const filename = await queuePath();
    const queue = await openTrackingQueue(filename);
    const queued = event();

    await expect(queue.enqueue(queued)).resolves.toBe(true);
    await expect(queue.enqueue(queued)).resolves.toBe(false);
    await expect(queue.dueAt(now)).resolves.toEqual([queued]);
    await expect((await openTrackingQueue(filename)).dueAt(now)).resolves.toEqual([queued]);
  });

  it("accepts and durably reloads a non-empty configured author", async () => {
    const filename = await queuePath();
    const queued = event({ author: "configured-agent" });

    await expect((await openTrackingQueue(filename)).enqueue(queued)).resolves.toBe(true);
    await expect((await openTrackingQueue(filename)).dueAt(now)).resolves.toEqual([queued]);
  });

  it("keeps staged events durably ineligible until their own session is confirmed idle", async () => {
    const filename = await queuePath();
    const queue = await openTrackingQueue(filename);
    const staged = event({ deliveryEligible: false });
    await queue.enqueue(staged);

    await expect(queue.dueAt(now)).resolves.toEqual([]);
    await expect((await openTrackingQueue(filename)).dueAt(now)).resolves.toEqual([]);
    await expect(queue.markDeliveryEligible("other-session")).resolves.toBe(false);
    await expect(queue.dueAt(now)).resolves.toEqual([]);
    await expect(queue.markDeliveryEligible(staged.sessionId)).resolves.toBe(true);
    await expect((await openTrackingQueue(filename)).dueAt(now)).resolves.toEqual([{ ...staged, deliveryEligible: true }]);
  });

  it("serializes concurrent duplicate enqueues", async () => {
    const queue = await openTrackingQueue(await queuePath());
    const queued = event();

    const results = await Promise.all([queue.enqueue(queued), queue.enqueue(queued)]);

    expect(results.sort()).toEqual([false, true]);
    await expect(queue.dueAt(now)).resolves.toEqual([queued]);
  });

  it("ignores stale temporary files and reads only the committed queue", async () => {
    const filename = await queuePath();
    const queue = await openTrackingQueue(filename);
    const queued = event();
    await queue.enqueue(queued);
    await fs.writeFile(`${filename}.interrupted.tmp`, "not queue JSON", { mode: 0o600 });

    await expect((await openTrackingQueue(filename)).dueAt(now)).resolves.toEqual([queued]);
  });

  it("does not expose an event when its atomic write fails", async () => {
    const filename = await queuePath();
    const initial = await openTrackingQueue(filename);
    await initial.enqueue(event());
    const failingFs = {
      ...fs,
      writeFile: async (): Promise<void> => {
        throw new Error("disk full");
      },
    };
    const queue = await openTrackingQueue(filename, failingFs);

    await expect(queue.enqueue(event({ idempotencyKey: "opencode:s-1:task-attached:m-2", eventId: "task-attached:m-2" }))).rejects.toThrow("disk full");
    await expect((await openTrackingQueue(filename)).dueAt(now)).resolves.toEqual([event()]);
  });

  it("updates retry state for only the selected event", async () => {
    const queue = await openTrackingQueue(await queuePath());
    const first = event();
    const second = event({
      idempotencyKey: "opencode:s-1:task-attached:m-2",
      eventId: "task-attached:m-2",
      kind: "task-attached",
    });
    await queue.enqueue(first);
    await queue.enqueue(second);

    await expect(queue.markRetry(first.idempotencyKey, 1, later)).resolves.toBe(true);
    await expect(queue.dueAt(now)).resolves.toEqual([second]);
    await expect(queue.dueAt(later)).resolves.toEqual([{ ...first, attempts: 1, nextAttemptAt: later }, second]);
  });

  it("moves terminal events to sanitized dead letters", async () => {
    const filename = await queuePath();
    const queue = await openTrackingQueue(filename);
    const queued = event();
    await queue.enqueue(queued);

    await expect(queue.markTerminal(queued.idempotencyKey, "server replied\n" + "x".repeat(300), later)).resolves.toBe(true);
    await expect(queue.dueAt(later)).resolves.toEqual([]);

    const stored = JSON.parse(await fs.readFile(filename, "utf8"));
    expect(stored).toMatchObject({
      version: 1,
      events: [],
      deadLetters: [{ ...queued, failedAt: later }],
    });
    expect(stored.deadLetters[0].reason).not.toContain("\n");
    expect(stored.deadLetters[0].reason.length).toBeLessThanOrEqual(200);
  });

  it("creates private parent and queue file permissions", async () => {
    const filename = path.join(await queuePath(), "private", "queue.json");
    await openTrackingQueue(filename);

    const [directory, file] = await Promise.all([fs.stat(path.dirname(filename)), fs.stat(filename)]);
    expect(directory.mode & 0o777).toBe(0o700);
    expect(file.mode & 0o777).toBe(0o600);
  });

  it("rejects malformed or unsupported queue files without exposing their contents", async () => {
    const filename = await queuePath();
    await fs.writeFile(filename, '{"version":2,"secret":"do not disclose"}', { mode: 0o600 });

    await expect(openTrackingQueue(filename)).rejects.toThrow("Tracking queue is malformed.");
    await expect(openTrackingQueue(filename)).rejects.not.toThrow("do not disclose");
  });
});
