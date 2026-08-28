import type { SessionState } from "./state";

export type ReminderRule = {
  id: string;
  matches: (state: SessionState) => boolean;
  text: string;
};

export const REMINDER_RULES: ReminderRule[] = [
  {
    id: "create-task",
    matches: (s) => s.taskId === null && s.hadMutatingToolCall,
    text:
      "This session has made changes but has no linked AI Task Tracker task yet. Consider calling create_task (or confirm to the user that no task is needed for this work).",
  },
  {
    id: "to-agent",
    matches: (s) => s.status === "TO_DO" && s.sawPlanOrSpecContext,
    text:
      "A spec/plan is in place for this task. Consider transition_task_status to TO_AGENT before starting implementation.",
  },
  {
    id: "to-review",
    matches: (s) => s.status === "TO_AGENT" && s.didCommitSinceLastReminder,
    text:
      "A commit was made on this task. Consider add_task_log with a summary and transition_task_status to TO_REVIEW.",
  },
  {
    id: "to-deploy",
    matches: (s) => s.status === "TO_REVIEW" && s.didPushOrOpenPr,
    text: "A push or PR/MR was detected for this task. Consider transition_task_status to TO_DEPLOY.",
  },
  {
    id: "done",
    matches: (s) => s.status === "TO_DEPLOY" && s.didDeployCommand,
    text: "A deploy-looking command was detected for this task. Consider transition_task_status to DONE.",
  },
];

export function evaluateReminder(state: SessionState): ReminderRule | null {
  for (const rule of REMINDER_RULES) {
    if (state.remindedFor.has(rule.id)) continue;
    if (rule.matches(state)) return rule;
  }
  return null;
}
