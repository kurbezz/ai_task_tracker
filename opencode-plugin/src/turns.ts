import type { TrackingEvent, TrackingQueue } from "./queue";
import { startTurn, type PendingAttachment, type SessionState, type SessionStore, type TurnState } from "./state";

export type ChatMessageTurnInput = {
  sessionID: string;
  messageID?: string;
};

export type CommandExecuteBeforeInput = {
  command: string;
  sessionID: string;
  arguments: string;
};

export type DeliverySignal = {
  signal(): void;
};

export type TurnTrackerDependencies = {
  queue: TrackingQueue;
  worker: DeliverySignal;
  author?: string;
  now?: () => Date;
};

export type ResponseProgressCandidate = {
  taskId: string;
  status: string;
  message: string;
};

type PendingProgress = {
  event: {
    eventId: string;
    taskId: string;
    createdAt: string;
    message: string;
  };
  enqueued: boolean;
};

type TurnFacts = {
  progressCandidate: ResponseProgressCandidate | null;
  progress: PendingProgress | null;
  successfulMcpLogTaskIds: Set<string>;
};

const turnFacts = new WeakMap<TurnState, TurnFacts>();
const finalizedTurns = new WeakSet<TurnState>();

/** Marks the current turn's pending intent only after its matching get_task call succeeded. */
export function markPendingAttachmentConfirmable(state: SessionState, taskId: string): boolean {
  const attachment = state.currentTurn?.pendingAttachment;
  if (!attachment || finalizedTurns.has(state.currentTurn!) || attachment.event.taskId !== taskId) return false;
  attachment.confirmable = true;
  return true;
}

/** Records a completed transition only when its task was confirmed for this turn. */
export function recordResponseProgressCandidate(
  state: SessionState,
  candidate: ResponseProgressCandidate,
): void {
  const turn = state.currentTurn;
  if (!turn || finalizedTurns.has(turn) || turn.attachedTaskId !== candidate.taskId) return;

  const facts = factsFor(turn);
  if (!facts.progress) facts.progressCandidate = candidate;
}

/** Records every successful active-turn MCP log, independent of transition event order. */
export function recordSuccessfulMcpTaskLog(state: SessionState, taskId: string): void {
  const turn = state.currentTurn;
  if (!turn || finalizedTurns.has(turn)) return;
  factsFor(turn).successfulMcpLogTaskIds.add(taskId);
}

export function getResponseProgressCandidate(state: SessionState): ResponseProgressCandidate | null {
  const turn = state.currentTurn;
  return turn ? turnFacts.get(turn)?.progressCandidate ?? null : null;
}

/**
 * Collects turn signals. `/tt` remains intent-only here; the entrypoint custom
 * tool must explicitly invoke confirmPendingAttachment after marking it.
 */
export function createTurnTracker(store: SessionStore, dependencies: TurnTrackerDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const author = requireAuthor(dependencies.author ?? "opencode");
  const inFlight = new Map<PendingAttachment | PendingProgress, Promise<boolean>>();

  return {
    onChatMessage(input: ChatMessageTurnInput): void {
      startTurn(store.get(input.sessionID), input.messageID, now());
    },

    onCommandExecuteBefore(input: CommandExecuteBeforeInput): void {
      if (input.command !== "tt") return;
      const taskId = oneTaskId(input.arguments);
      if (!taskId) return;

      const state = store.get(input.sessionID);
      // Command hooks may arrive while an old turn is still current. Never use it.
      if (!state.pendingAttachmentTaskId) state.pendingAttachmentTaskId = taskId;
    },

    /**
     * Explicit confirmation entrypoint for the future custom tool. It only
     * persists an attachment that a same-turn matching get_task result marked.
     */
    async confirmPendingAttachment(sessionID: string): Promise<boolean> {
      const state = store.get(sessionID);
      const turn = state.currentTurn;
      const attachment = turn?.pendingAttachment;
      if (!turn || !attachment || !attachment.confirmable) return false;

      if (!attachment.enqueued) {
        await persistOnce(
          sessionID,
          attachment,
          dependencies.queue,
          inFlight,
          (id, pending, queue) => persistAttachment(id, pending, author, queue),
        );
      }
      state.attachedTaskId = attachment.event.taskId;
      turn.attachedTaskId = attachment.event.taskId;
      return true;
    },

    async onSessionIdle(sessionID: string): Promise<void> {
      const state = store.get(sessionID);
      const turn = state.currentTurn;
      let deliveryReady = await dependencies.queue.markDeliveryEligible(sessionID);
      if (!turn || finalizedTurns.has(turn)) {
        if (deliveryReady) dependencies.worker.signal();
        return;
      }

      const facts = turnFacts.get(turn);
      const candidate = facts?.progressCandidate;
      if (candidate && !facts.successfulMcpLogTaskIds.has(candidate.taskId)) {
        const progress = facts.progress ?? createPendingProgress(turn, candidate, now());
        facts.progress = progress;
        if (!progress.enqueued) {
          deliveryReady = (await persistOnce(sessionID, progress, dependencies.queue, inFlight, (id, pending, queue) => persistProgress(id, pending, author, queue))) || deliveryReady;
        }
      }

      finalizedTurns.add(turn);
      turnFacts.delete(turn);
      if (deliveryReady) dependencies.worker.signal();
    },
  };
}

function factsFor(turn: TurnState): TurnFacts {
  let facts = turnFacts.get(turn);
  if (!facts) {
    facts = { progressCandidate: null, progress: null, successfulMcpLogTaskIds: new Set() };
    turnFacts.set(turn, facts);
  }
  return facts;
}

function createPendingProgress(turn: TurnState, candidate: ResponseProgressCandidate, createdAt: Date): PendingProgress {
  return {
    event: {
      eventId: `response-progress:${turn.id}`,
      taskId: candidate.taskId,
      createdAt: createdAt.toISOString(),
      message: candidate.message,
    },
    enqueued: false,
  };
}

async function persistOnce<T extends PendingAttachment | PendingProgress>(
  sessionID: string,
  pendingEvent: T,
  queue: TrackingQueue,
  inFlight: Map<PendingAttachment | PendingProgress, Promise<boolean>>,
  persist: (sessionID: string, pendingEvent: T, queue: TrackingQueue) => Promise<boolean>,
): Promise<boolean> {
  let pending = inFlight.get(pendingEvent);
  if (!pending) {
    pending = persist(sessionID, pendingEvent, queue);
    inFlight.set(pendingEvent, pending);
    void pending.then(
      () => inFlight.delete(pendingEvent),
      () => inFlight.delete(pendingEvent),
    );
  }
  return await pending;
}

async function persistAttachment(
  sessionID: string,
  attachment: PendingAttachment,
  author: string,
  queue: TrackingQueue,
): Promise<boolean> {
  const event: TrackingEvent = {
    ...attachment.event,
    idempotencyKey: `opencode:${sessionID}:${attachment.event.eventId}`,
    sessionId: sessionID,
    kind: "task-attached",
    author,
    message: `Attached task ${attachment.event.taskId} via /tt.`,
    attempts: 0,
    nextAttemptAt: attachment.event.createdAt,
    deliveryEligible: false,
  };
  const enqueued = await queue.enqueue(event);
  attachment.enqueued = true;
  return enqueued;
}

async function persistProgress(
  sessionID: string,
  progress: PendingProgress,
  author: string,
  queue: TrackingQueue,
): Promise<boolean> {
  const event: TrackingEvent = {
    ...progress.event,
    idempotencyKey: `opencode:${sessionID}:${progress.event.eventId}`,
    sessionId: sessionID,
    kind: "response-progress",
    author,
    attempts: 0,
    nextAttemptAt: progress.event.createdAt,
    deliveryEligible: true,
  };
  const enqueued = await queue.enqueue(event);
  progress.enqueued = true;
  return enqueued;
}

function requireAuthor(author: string): string {
  const normalized = typeof author === "string" ? author.trim() : "";
  if (!normalized) throw new Error("Configured author must be a non-empty string.");
  return normalized;
}

function oneTaskId(argumentsText: string): string | null {
  const tokens = argumentsText.trim().split(/\s+/).filter(Boolean);
  return tokens.length === 1 ? tokens[0] : null;
}
