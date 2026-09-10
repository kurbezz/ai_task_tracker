import { randomUUID } from "node:crypto";

export type TrackerStatus = "TO_DO" | "TO_AGENT" | "TO_REVIEW" | "TO_DEPLOY" | "DONE";

export type PendingAttachment = {
  event: {
    eventId: string;
    taskId: string;
    createdAt: string;
  };
  confirmable: boolean;
  enqueued: boolean;
};

export type TurnState = {
  id: string;
  attachedTaskId: string | null;
  pendingAttachment: PendingAttachment | null;
};

export type SessionState = {
  taskId: string | null;
  status: TrackerStatus | null;
  hadMutatingToolCall: boolean;
  sawPlanOrSpecContext: boolean;
  didCommitSinceLastReminder: boolean;
  didPushOrOpenPr: boolean;
  didDeployCommand: boolean;
  remindedFor: Set<string>;
  pendingReminder: string | null;
  attachedTaskId: string | null;
  pendingAttachmentTaskId: string | null;
  currentTurn: TurnState | null;
};

export function createSessionState(): SessionState {
  return {
    taskId: null,
    status: null,
    hadMutatingToolCall: false,
    sawPlanOrSpecContext: false,
    didCommitSinceLastReminder: false,
    didPushOrOpenPr: false,
    didDeployCommand: false,
    remindedFor: new Set(),
    pendingReminder: null,
    attachedTaskId: null,
    pendingAttachmentTaskId: null,
    currentTurn: null,
  };
}

/** Starts a user turn, binds a command-before intent, and snapshots its confirmed task. */
export function startTurn(state: SessionState, messageID?: string, startedAt: Date = new Date()): TurnState {
  const messageId = messageID?.trim();
  if (messageId && state.currentTurn?.id === messageId) return state.currentTurn;

  const id = messageId || randomUUID();
  const pendingTaskId = state.pendingAttachmentTaskId;
  state.pendingAttachmentTaskId = null;
  const turn: TurnState = {
    id,
    attachedTaskId: state.attachedTaskId,
    pendingAttachment: pendingTaskId
      ? {
          event: {
            eventId: `task-attached:${id}`,
            taskId: pendingTaskId,
            createdAt: startedAt.toISOString(),
          },
          confirmable: false,
          enqueued: false,
        }
      : null,
  };
  state.currentTurn = turn;
  return turn;
}

export type SessionStore = {
  get(sessionID: string): SessionState;
};

export function createSessionStore(): SessionStore {
  const sessions = new Map<string, SessionState>();
  return {
    get(sessionID: string): SessionState {
      let state = sessions.get(sessionID);
      if (!state) {
        state = createSessionState();
        sessions.set(sessionID, state);
      }
      return state;
    },
  };
}
