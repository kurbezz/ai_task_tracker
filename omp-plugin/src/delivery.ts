import type { TrackerConfig } from "./config";
import { openTrackingQueue, type TrackingEvent, type TrackingQueue } from "./queue";

type Timer = ReturnType<typeof setTimeout>;

export type DeliveryDependencies = {
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  random?: () => number;
  setTimeout?: (callback: () => void, delay: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
  openQueue?: (filename: string) => Promise<TrackingQueue>;
  diagnostic?: (message: string) => void;
};

const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_RETRY_DELAY_MS = 300_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const ALL_FUTURE = "9999-12-31T23:59:59.999Z";

/** Delivers persisted tracker events without blocking an OpenCode hook. */
export class TrackingDeliveryWorker {
  private queue: TrackingQueue | undefined;
  private readonly inFlight = new Set<string>();
  private readonly timers = new Map<string, Timer>();
  private drainQueued = false;
  private disposed = false;

  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly setTimer: (callback: () => void, delay: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private readonly openQueue: (filename: string) => Promise<TrackingQueue>;
  private readonly diagnostic: (message: string) => void;

  constructor(
    private readonly config: TrackerConfig,
    dependencies: DeliveryDependencies = {},
  ) {
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.now = dependencies.now ?? (() => new Date());
    this.random = dependencies.random ?? Math.random;
    this.setTimer = dependencies.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = dependencies.clearTimeout ?? ((timer) => clearTimeout(timer));
    this.openQueue = dependencies.openQueue ?? openTrackingQueue;
    this.diagnostic = dependencies.diagnostic ?? (() => undefined);
  }

  /** Opens the durable queue and schedules delivery recovery independent of a session. */
  async start(): Promise<void> {
    await this.getQueue();
    if (!this.disposed) this.runDetached(() => this.recover());
  }

  /** Requests an asynchronous drain after an event was durably enqueued. */
  signal(): void {
    if (this.disposed || this.drainQueued) return;
    this.drainQueued = true;
    queueMicrotask(() => {
      this.drainQueued = false;
      if (!this.disposed) this.runDetached(() => this.drainDue());
    });
  }

  /** Stops scheduled retries. It does not cancel an HTTP request already in progress. */
  stop(): void {
    this.dispose();
  }

  /** Stops scheduled work. It does not cancel an HTTP request already in progress. */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
  }

  async deliver(event: TrackingEvent): Promise<void> {
    if (this.inFlight.has(event.idempotencyKey)) return;
    this.inFlight.add(event.idempotencyKey);
    try {
      let response: Response;
      try {
        response = await this.send(event);
      } catch {
        // Fetch failures (including AbortSignal timeout) have no reliable server outcome.
        // Do not include error text: it can contain a URL or other transport details.
        try {
          await this.persistAndScheduleRetry(event);
        } catch (retryError) {
          this.handleQueueMutationFailure(event, "AI Task Tracker delivery retry could not be persisted.");
          throw retryError;
        }
        return;
      }

      if (response.status >= 200 && response.status < 300) {
        this.clearScheduled(event.idempotencyKey);
        try {
          await (await this.getQueue()).removeDelivered(event.idempotencyKey);
        } catch (error) {
          this.handleQueueMutationFailure(event, "AI Task Tracker delivered event could not be removed from the queue.");
          throw error;
        }
        return;
      }

      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        try {
          await this.persistAndScheduleRetry(event, retryAfterDelay(response, this.now()));
        } catch (error) {
          this.handleQueueMutationFailure(event, "AI Task Tracker delivery retry could not be persisted.");
          throw error;
        }
        return;
      }

      this.clearScheduled(event.idempotencyKey);
      try {
        await (await this.getQueue()).markTerminal(event.idempotencyKey, `HTTP ${response.status}`, this.now().toISOString());
      } catch (error) {
        this.handleQueueMutationFailure(event, "AI Task Tracker terminal delivery state could not be persisted.");
        throw error;
      }
    } finally {
      this.inFlight.delete(event.idempotencyKey);
    }
  }

  private async send(event: TrackingEvent): Promise<Response> {
    const baseUrl = this.config.baseUrl.replace(/\/+$/, "");
    const endpoint = `${baseUrl}/api/tasks/${encodeURIComponent(event.taskId)}/logs`;
    return this.fetch(endpoint, {
      method: "POST",
      headers: {
        "X-Api-Key": this.config.apiKey,
        "Content-Type": "application/json",
        "Idempotency-Key": event.idempotencyKey,
      },
      body: JSON.stringify({ author: event.author, message: event.message }),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      redirect: "error",
    });
  }

  private async recover(): Promise<void> {
    const queue = await this.getQueue();
    const current = this.now();
    const events = await queue.dueAt(ALL_FUTURE);
    for (const event of events) {
      if (event.nextAttemptAt <= current.toISOString()) {
        this.runDetached(() => this.deliver(event));
      } else {
        this.schedule(event, new Date(event.nextAttemptAt).getTime() - current.getTime());
      }
    }
  }

  private async drainDue(): Promise<void> {
    try {
      const events = await (await this.getQueue()).dueAt(this.now().toISOString());
      for (const event of events) this.runDetached(() => this.deliver(event));
    } catch {
      this.safeDiagnostic("AI Task Tracker delivery queue is unavailable.");
    }
  }

  private async persistAndScheduleRetry(event: TrackingEvent, serverDelay?: number): Promise<void> {
    const attempts = event.attempts + 1;
    const delay = serverDelay ?? backoffDelay(attempts, this.random());
    const nextAttemptAt = new Date(this.now().getTime() + delay).toISOString();
    await (await this.getQueue()).markRetry(event.idempotencyKey, attempts, nextAttemptAt);
    this.schedule({ ...event, attempts, nextAttemptAt }, delay);
  }

  private schedule(event: TrackingEvent, requestedDelay: number): void {
    const dueAt = new Date(event.nextAttemptAt).getTime();
    this.scheduleRescan(
      event.idempotencyKey,
      Number.isFinite(dueAt) ? dueAt : this.now().getTime() + Math.max(0, requestedDelay),
    );
  }

  private scheduleRescan(idempotencyKey: string, dueAt: number): void {
    if (this.disposed) return;
    this.clearScheduled(idempotencyKey);
    const remaining = dueAt - this.now().getTime();
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, Number.isFinite(remaining) ? remaining : 0));
    const timer = this.setTimer(() => {
      this.timers.delete(idempotencyKey);
      this.runDetached(async () => {
        if (this.disposed) return;
        if (dueAt > this.now().getTime()) {
          this.scheduleRescan(idempotencyKey, dueAt);
          return;
        }
        await this.drainDue();
      });
    }, delay);
    this.timers.set(idempotencyKey, timer);
  }

  private clearScheduled(idempotencyKey: string): void {
    const timer = this.timers.get(idempotencyKey);
    if (timer !== undefined) this.clearTimer(timer);
    this.timers.delete(idempotencyKey);
  }

  private handleQueueMutationFailure(event: TrackingEvent, diagnostic: string): void {
    this.safeDiagnostic(diagnostic);
    this.scheduleRescan(event.idempotencyKey, this.now().getTime() + backoffDelay(event.attempts + 1, this.random()));
  }

  private async getQueue(): Promise<TrackingQueue> {
    if (!this.queue) this.queue = await this.openQueue(this.config.queuePath);
    return this.queue;
  }

  private safeDiagnostic(message: string): void {
    try {
      this.diagnostic(message);
    } catch {
      // Diagnostics must not affect delivery.
    }
  }

  private runDetached(operation: () => Promise<void>): void {
    try {
      void operation().catch(() => {
        this.safeDiagnostic("AI Task Tracker delivery background operation failed.");
      });
    } catch {
      this.safeDiagnostic("AI Task Tracker delivery background operation failed.");
    }
  }
}

function retryAfterDelay(response: Response, now: Date): number | undefined {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) return undefined;

  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return seconds * 1_000;
  }

  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - now.getTime());
  return undefined;
}

function backoffDelay(attempts: number, random: number): number {
  const base = Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** (attempts - 1));
  return base * (0.5 + Math.min(1, Math.max(0, random)));
}
