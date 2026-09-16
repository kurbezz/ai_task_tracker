import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readTrackerConfig } from "./src/config";
import { TrackingDeliveryWorker } from "./src/delivery";
import { openTrackingQueue, type TrackingQueue } from "./src/queue";
import { evaluateLifecycleReminder } from "./src/reminders";
import { createSessionStore } from "./src/state";
import { applyToolExecuteAfter } from "./src/tool-events";
import { normalizeToolOutput } from "./src/tool-output";
import { createTurnTracker, type TurnTracker } from "./src/turns";

/**
 * Ports the OpenCode `ai-task-tracker-nudge` plugin to omp's extension runtime.
 *
 * Event mapping (opencode -> omp):
 *  - `session.hook("prompt")`         -> `agent_start`          (fires once per user prompt)
 *  - `session.hook("context")`        -> `before_agent_start`   (system-prompt override persists for the whole turn)
 *  - `tool.hook("execute.after")`     -> `tool_result`
 *  - `event.subscribe("session.idle")`-> `agent_end` (guarded on `!willContinue`)
 *  - `tool.transform` custom tool     -> `registerTool`
 *  - plugin `setup()` cleanup         -> `session_shutdown`
 */
export default async function aiTaskTrackerNudge(pi: ExtensionAPI): Promise<void> {
  const store = createSessionStore();
  const config = readTrackerConfig();
  let worker: TrackingDeliveryWorker | undefined;
  let turns: TurnTracker | undefined;

  const signalDelivery = {
    signal: () => {
      try {
        worker?.signal();
      } catch {
        pi.logger.warn("AI Task Tracker automatic delivery signal failed.");
      }
    },
  };

  if (config.enabled) {
    try {
      const queue: TrackingQueue = await openTrackingQueue(config.queuePath);
      worker = new TrackingDeliveryWorker(config);
      await worker.start();
      turns = createTurnTracker(store, { queue, worker: signalDelivery, author: config.author });
    } catch {
      pi.logger.warn("AI Task Tracker automatic logging unavailable; continuing without direct logging.");
      worker = undefined;
      turns = undefined;
    }
  } else {
    pi.logger.warn(config.diagnostic);
  }

  pi.on("agent_start", async (_event, ctx) => {
    turns?.onChatMessage({ sessionID: ctx.sessionManager.getSessionId() });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = store.get(sessionId);
    const systemPrompt = [...event.systemPrompt, `## AI Task Tracker session\nCurrent omp session id: ${sessionId}`];
    if (state.pendingReminder) {
      systemPrompt.push(`## AI Task Tracker reminder\n${state.pendingReminder}`);
      state.pendingReminder = null;
    }
    return { systemPrompt };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    applyToolExecuteAfter(store.get(ctx.sessionManager.getSessionId()), {
      tool: event.toolName,
      args: event.input,
      outputText: normalizeToolOutput({ content: event.content, output: event.details }),
    });
  });

  pi.on("agent_end", async (event, ctx) => {
    if (event.willContinue) return;
    const sessionId = ctx.sessionManager.getSessionId();
    try {
      await turns?.onSessionIdle(sessionId);
    } catch {
      pi.logger.warn("AI Task Tracker automatic logging confirmation failed.");
    }

    const state = store.get(sessionId);
    const rule = evaluateLifecycleReminder(state);
    if (!rule) return;
    state.remindedFor.add(rule.id);
    state.pendingReminder = rule.text;
    state.didCommitSinceLastReminder = false;
    state.didPushOrOpenPr = false;
    state.didDeployCommand = false;
  });

  pi.registerTool({
    name: "task_tracker_mark_attachment_candidate",
    label: "Mark Task Attachment Candidate",
    description: "Queue a successfully validated task attachment for post-response delivery.",
    parameters: pi.zod.object({
      task_id: pi.zod.string().min(1),
    }),
    async execute(_toolCallId: string, params: { task_id: string }, _signal, _onUpdate, ctx) {
      try {
        const queued = await turns?.queueValidatedAttachment(ctx.sessionManager.getSessionId(), params.task_id);
        return {
          content: [
            {
              type: "text",
              text: queued ? "Attachment candidate queued." : "No verified attachment candidate to queue.",
            },
          ],
        };
      } catch {
        pi.logger.warn("AI Task Tracker attachment candidate could not be queued.");
        return { content: [{ type: "text", text: "Attachment candidate could not be queued." }] };
      }
    },
  });

  pi.on("session_shutdown", async () => {
    worker?.stop();
  });
}
