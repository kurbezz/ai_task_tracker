import type { SessionState, TrackerStatus } from "./state";
import {
  isCommitCommand,
  isPushOrPrCommand,
  isDeployCommand,
  isPlanOrSpecPath,
  extractTrackerToolName,
  toolNameIncludes,
} from "./matchers";

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
  if (
    trackerTool === "transition_task_status" &&
    typeof args.status === "string" &&
    VALID_STATUSES.has(args.status)
  ) {
    state.status = args.status as TrackerStatus;
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
