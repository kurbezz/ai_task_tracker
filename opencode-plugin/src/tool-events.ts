import type { SessionState, TrackerStatus } from "./state";
import {
  isCommitCommand,
  isPushOrPrCommand,
  isDeployCommand,
  isPlanOrSpecPath,
  extractTrackerToolName,
  toolNameIncludes,
} from "./matchers";
import {
  markPendingAttachmentConfirmable,
  recordResponseProgressCandidate,
  recordSuccessfulMcpTaskLog,
} from "./turns";

export type ToolAfterEvent = {
  tool: string;
  args: Record<string, unknown>;
  outputText: string;
};

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "TO_DO",
  "TO_AGENT",
  "TO_REVIEW",
  "TO_DEPLOY",
  "DONE",
]);

export function applyToolExecuteAfter(state: SessionState, event: ToolAfterEvent): void {
  const { tool, args, outputText } = event;
  const command = typeof args.command === "string" ? args.command : null;

  if (command && toolNameIncludes(tool, "bash")) {
    if (isCommitCommand(command)) state.didCommitSinceLastReminder = true;
    if (isPushOrPrCommand(command)) state.didPushOrOpenPr = true;
    if (isDeployCommand(command)) state.didDeployCommand = true;
  }

  if (
    toolNameIncludes(tool, "bash") ||
    toolNameIncludes(tool, "edit") ||
    toolNameIncludes(tool, "write")
  ) {
    state.hadMutatingToolCall = true;
  }

  const trackerTool = extractTrackerToolName(tool);
  if (trackerTool === "create_task" || trackerTool === "get_task") {
    const parsed = tryParseJson(outputText);
    if (parsed && typeof parsed.id === "string") state.taskId = parsed.id;
    if (parsed && typeof parsed.status === "string" && VALID_STATUSES.has(parsed.status)) {
      state.status = parsed.status as TrackerStatus;
    }
  }
  if (trackerTool === "get_task") {
    const parsed = tryParseJson(outputText);
    const requestedTaskId = typeof args.task_id === "string" ? args.task_id : null;
    if (requestedTaskId && parsed && isSuccessfulTaskResult(parsed) && parsed.id === requestedTaskId) {
      markPendingAttachmentConfirmable(state, requestedTaskId);
    }
  }
  if (
    trackerTool === "transition_task_status" &&
    typeof args.status === "string" &&
    VALID_STATUSES.has(args.status)
  ) {
    state.status = args.status as TrackerStatus;
  }

  if (trackerTool === "transition_task_status") {
    const parsed = tryParseJson(outputText);
    const taskId = typeof args.task_id === "string" ? args.task_id : null;
    if (
      taskId &&
      parsed?.id === taskId &&
      typeof parsed.status === "string" &&
      VALID_STATUSES.has(parsed.status)
    ) {
      recordResponseProgressCandidate(state, {
        taskId,
        status: parsed.status,
        message: `Updated task ${taskId} status to ${parsed.status}.`,
      });
    }
  }

  if (trackerTool === "add_task_log") {
    const parsed = tryParseJson(outputText);
    if (parsed && isSuccessfulTaskLog(parsed)) recordSuccessfulMcpTaskLog(state, parsed.task_id);
  }

  const path =
    typeof args.filePath === "string"
      ? args.filePath
      : typeof args.path === "string"
        ? args.path
        : null;
  if (path && isPlanOrSpecPath(path)) {
    state.sawPlanOrSpecContext = true;
  }
}

function tryParseJson(text: string): Record<string, unknown> | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function isSuccessfulTaskLog(value: Record<string, unknown>): value is Record<string, string> & { task_id: string } {
  return hasNonEmptyString(value, "id")
    && hasNonEmptyString(value, "task_id")
    && hasNonEmptyString(value, "author")
    && hasNonEmptyString(value, "message")
    && hasNonEmptyString(value, "created_at");
}

function isSuccessfulTaskResult(value: Record<string, unknown>): value is Record<string, string> & { id: string } {
  return hasNonEmptyString(value, "id")
    && typeof value.status === "string"
    && VALID_STATUSES.has(value.status)
    && value.error === undefined;
}

function hasNonEmptyString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string" && value[key].trim().length > 0;
}
