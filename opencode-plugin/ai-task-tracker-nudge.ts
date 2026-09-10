import { tool, type Plugin } from "@opencode-ai/plugin";
import { readTrackerConfig } from "./src/config";
import { TrackingDeliveryWorker } from "./src/delivery";
import { openTrackingQueue, type TrackingQueue } from "./src/queue";
import { createSessionStore } from "./src/state";
import { applyToolExecuteAfter } from "./src/tool-events";
import { createTurnTracker } from "./src/turns";
import { evaluateLifecycleReminder } from "./src/reminders";

export const AiTaskTrackerNudge: Plugin = async () => {
  const store = createSessionStore();
  const config = readTrackerConfig();
  let worker: TrackingDeliveryWorker | undefined;
  let turns: ReturnType<typeof createTurnTracker> | undefined;
  const signalDelivery = {
    signal: () => {
      try {
        worker?.signal();
      } catch {
        console.warn("AI Task Tracker automatic delivery signal failed.");
      }
    },
  };

  if (config.enabled) {
    let queue: TrackingQueue = unavailableQueue();
    try {
      queue = await openTrackingQueue(config.queuePath);
      worker = new TrackingDeliveryWorker(config);
      await worker.start();
    } catch {
      console.warn("AI Task Tracker automatic logging unavailable; continuing without direct logging.");
      worker = undefined;
    }
    turns = createTurnTracker(store, { queue, worker: signalDelivery, author: config.author });
  } else {
    console.warn(config.diagnostic);
  }

  return {
    "chat.message": async (input) => {
      turns?.onChatMessage({ sessionID: input.sessionID, messageID: input.messageID });
    },

    "command.execute.before": async (input) => {
      turns?.onCommandExecuteBefore({
        command: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
      });
    },

    "tool.execute.after": async (input, output) => {
      const state = store.get(input.sessionID);
      applyToolExecuteAfter(state, {
        tool: input.tool,
        args: (input.args as Record<string, unknown>) ?? {},
        outputText: output.output ?? "",
      });
    },

    tool: {
      task_tracker_mark_attachment_candidate: tool({
        description: "Queue the verified /tt attachment candidate for post-response delivery.",
        args: {},
        execute: async (_args, context) => {
          try {
            const queued = await turns?.confirmPendingAttachment(context.sessionID);
            return queued ? "Attachment candidate queued." : "No verified attachment candidate to queue.";
          } catch {
            console.warn("AI Task Tracker attachment candidate could not be queued.");
            return "Attachment candidate could not be queued.";
          }
        },
      }),
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return;
      const sessionID = (event as { properties: { sessionID: string } }).properties.sessionID;
      try {
        await turns?.onSessionIdle(sessionID);
      } catch {
        console.warn("AI Task Tracker automatic logging confirmation failed.");
      }

      const state = store.get(sessionID);
      const rule = evaluateLifecycleReminder(state);
      if (!rule) return;
      state.remindedFor.add(rule.id);
      state.pendingReminder = rule.text;
      state.didCommitSinceLastReminder = false;
      state.didPushOrOpenPr = false;
      state.didDeployCommand = false;
    },

    dispose: async () => {
      worker?.stop();
    },

    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input.sessionID;
      if (!sessionID) return;
      // No opencode mechanism exports the session id into the shell env used by
      // the bash tool, so `/tt` cannot read it via `echo $OPENCODE_SESSION_ID`.
      // Inject it directly into the system prompt instead.
      output.system.push(`## AI Task Tracker session\nCurrent opencode session id: ${sessionID}`);
      const state = store.get(sessionID);
      if (!state.pendingReminder) return;
      output.system.push(`## AI Task Tracker reminder\n${state.pendingReminder}`);
      state.pendingReminder = null;
    },
  };
};

export default AiTaskTrackerNudge;

function unavailableQueue(): TrackingQueue {
  return {
    enqueue: async () => { throw new Error("AI Task Tracker queue is unavailable."); },
    dueAt: async () => [],
    removeDelivered: async () => false,
    markRetry: async () => false,
    markTerminal: async () => false,
    markDeliveryEligible: async () => false,
  };
}
