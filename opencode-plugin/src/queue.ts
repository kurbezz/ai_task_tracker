import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type TrackingEvent = {
  idempotencyKey: string;
  sessionId: string;
  eventId: string;
  taskId: string;
  kind: "task-attached" | "response-progress";
  author: string;
  message: string;
  createdAt: string;
  attempts: number;
  nextAttemptAt: string;
  /** Attachments remain undeliverable until their owning session is idle. */
  deliveryEligible: boolean;
};

export type DeadLetter = TrackingEvent & {
  failedAt: string;
  reason: string;
};

export type QueueFile = {
  version: 1;
  events: TrackingEvent[];
  deadLetters: DeadLetter[];
};

export type TrackingQueueFileSystem = Pick<
  typeof nodeFs,
  "mkdir" | "open" | "readFile" | "rename" | "writeFile"
>;

export type TrackingQueue = {
  enqueue(event: TrackingEvent): Promise<boolean>;
  dueAt(at: string): Promise<TrackingEvent[]>;
  removeDelivered(idempotencyKey: string): Promise<boolean>;
  markRetry(idempotencyKey: string, attempts: number, nextAttemptAt: string): Promise<boolean>;
  markTerminal(idempotencyKey: string, reason: string, failedAt?: string): Promise<boolean>;
  markDeliveryEligible(sessionId: string): Promise<boolean>;
};

class PromiseMutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const mutexes = new Map<string, PromiseMutex>();

function mutexFor(filename: string): PromiseMutex {
  const canonical = resolve(filename);
  let mutex = mutexes.get(canonical);
  if (!mutex) {
    mutex = new PromiseMutex();
    mutexes.set(canonical, mutex);
  }
  return mutex;
}

export async function openTrackingQueue(
  filename: string,
  filesystem: TrackingQueueFileSystem = nodeFs,
): Promise<TrackingQueue> {
  const queue = new FileTrackingQueue(filename, filesystem, mutexFor(filename));
  await queue.initialize();
  return queue;
}

class FileTrackingQueue implements TrackingQueue {
  constructor(
    private readonly filename: string,
    private readonly filesystem: TrackingQueueFileSystem,
    private readonly mutex: PromiseMutex,
  ) {}

  async initialize(): Promise<void> {
    await this.mutex.run(async () => {
      await this.filesystem.mkdir(dirname(this.filename), { mode: 0o700, recursive: true });
      if ((await this.readEnvelope()) === undefined) {
        await this.writeEnvelope(emptyQueue());
      }
    });
  }

  enqueue(event: TrackingEvent): Promise<boolean> {
    assertTrackingEvent(event);
    return this.mutate((queue) => {
      if (hasIdempotencyKey(queue, event.idempotencyKey)) return { changed: false, result: false };
      queue.events.push({ ...event });
      return { changed: true, result: true };
    });
  }

  dueAt(at: string): Promise<TrackingEvent[]> {
    return this.mutex.run(async () => {
      const queue = await this.requiredEnvelope();
      return queue.events
        .filter((event) => event.deliveryEligible && event.nextAttemptAt <= at)
        .map((event) => ({ ...event }));
    });
  }

  removeDelivered(idempotencyKey: string): Promise<boolean> {
    return this.mutate((queue) => {
      const index = queue.events.findIndex((event) => event.idempotencyKey === idempotencyKey);
      if (index < 0) return { changed: false, result: false };
      queue.events.splice(index, 1);
      return { changed: true, result: true };
    });
  }

  markRetry(idempotencyKey: string, attempts: number, nextAttemptAt: string): Promise<boolean> {
    if (!Number.isSafeInteger(attempts) || attempts < 0 || typeof nextAttemptAt !== "string") {
      throw new Error("Invalid tracking queue retry state.");
    }
    return this.mutate((queue) => {
      const event = queue.events.find((candidate) => candidate.idempotencyKey === idempotencyKey);
      if (!event) return { changed: false, result: false };
      event.attempts = attempts;
      event.nextAttemptAt = nextAttemptAt;
      return { changed: true, result: true };
    });
  }

  markTerminal(idempotencyKey: string, reason: string, failedAt = new Date().toISOString()): Promise<boolean> {
    return this.mutate((queue) => {
      const index = queue.events.findIndex((event) => event.idempotencyKey === idempotencyKey);
      if (index < 0) return { changed: false, result: false };
      const [event] = queue.events.splice(index, 1);
      queue.deadLetters.push({ ...event, failedAt, reason: sanitizeReason(reason) });
      return { changed: true, result: true };
    });
  }

  markDeliveryEligible(sessionId: string): Promise<boolean> {
    return this.mutate((queue) => {
      let changed = false;
      for (const event of queue.events) {
        if (event.sessionId === sessionId && !event.deliveryEligible) {
          event.deliveryEligible = true;
          changed = true;
        }
      }
      return { changed, result: changed };
    });
  }

  private mutate<T>(operation: (queue: QueueFile) => { changed: boolean; result: T }): Promise<T> {
    return this.mutex.run(async () => {
      const queue = await this.requiredEnvelope();
      const outcome = operation(queue);
      if (outcome.changed) await this.writeEnvelope(queue);
      return outcome.result;
    });
  }

  private async requiredEnvelope(): Promise<QueueFile> {
    const queue = await this.readEnvelope();
    if (!queue) throw new Error("Tracking queue is unavailable.");
    return queue;
  }

  private async readEnvelope(): Promise<QueueFile | undefined> {
    let source: string;
    try {
      source = await this.filesystem.readFile(this.filename, "utf8");
    } catch (error: unknown) {
      if (isNotFound(error)) return undefined;
      throw error;
    }

    try {
      const parsed: unknown = JSON.parse(source);
      if (!isQueueFile(parsed)) throw new Error("invalid queue");
      return parsed;
    } catch {
      throw malformedQueueError();
    }
  }

  private async writeEnvelope(queue: QueueFile): Promise<void> {
    const temporary = `${this.filename}.${process.pid}.${randomUUID()}.tmp`;
    await this.filesystem.writeFile(temporary, JSON.stringify(queue), { mode: 0o600 });

    const temporaryHandle = await this.filesystem.open(temporary, "r");
    try {
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }

    await this.filesystem.rename(temporary, this.filename);

    const directoryHandle = await this.filesystem.open(dirname(this.filename), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }
}

function emptyQueue(): QueueFile {
  return { version: 1, events: [], deadLetters: [] };
}

function hasIdempotencyKey(queue: QueueFile, idempotencyKey: string): boolean {
  return queue.events.some((event) => event.idempotencyKey === idempotencyKey)
    || queue.deadLetters.some((event) => event.idempotencyKey === idempotencyKey);
}

function isQueueFile(value: unknown): value is QueueFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.events) || !Array.isArray(value.deadLetters)) {
    return false;
  }
  return value.events.every(isTrackingEvent)
    && value.deadLetters.every(isDeadLetter);
}

function isDeadLetter(value: unknown): value is DeadLetter {
  if (!isRecord(value)) return false;
  const record = value;
  return isTrackingEvent(value)
    && typeof record.failedAt === "string"
    && typeof record.reason === "string";
}

function isTrackingEvent(value: unknown): value is TrackingEvent {
  if (!isRecord(value)) return false;
  const attempts = value.attempts;
  return typeof value.idempotencyKey === "string"
    && typeof value.sessionId === "string"
    && typeof value.eventId === "string"
    && typeof value.taskId === "string"
    && (value.kind === "task-attached" || value.kind === "response-progress")
    && typeof value.author === "string"
    && value.author.trim().length > 0
    && typeof value.message === "string"
    && typeof value.createdAt === "string"
    && typeof attempts === "number"
    && Number.isSafeInteger(attempts)
    && attempts >= 0
    && typeof value.nextAttemptAt === "string"
    && typeof value.deliveryEligible === "boolean";
}

function assertTrackingEvent(event: TrackingEvent): void {
  if (!isTrackingEvent(event)) throw new Error("Invalid tracking event.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return isRecord(error) && error.code === "ENOENT";
}

function malformedQueueError(): Error {
  return new Error("Tracking queue is malformed.");
}

function sanitizeReason(reason: string): string {
  const normalized = String(reason).replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  return (normalized || "delivery failed").slice(0, 200);
}
