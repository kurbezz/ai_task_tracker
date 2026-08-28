export type TrackerStatus = "TO_DO" | "TO_AGENT" | "TO_REVIEW" | "TO_DEPLOY" | "DONE";

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
  };
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
