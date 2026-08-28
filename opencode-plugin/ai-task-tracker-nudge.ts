import type { Plugin } from "@opencode-ai/plugin";
import { createSessionStore } from "./src/state";
import { applyToolExecuteAfter } from "./src/tool-events";
import { evaluateReminder } from "./src/reminders";

export const AiTaskTrackerNudge: Plugin = async () => {
  const store = createSessionStore();

  return {
    "tool.execute.after": async (input, output) => {
      const state = store.get(input.sessionID);
      applyToolExecuteAfter(state, {
        tool: input.tool,
        args: (input.args as Record<string, unknown>) ?? {},
        outputText: output.output ?? "",
      });
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return;
      const sessionID = (event as { properties: { sessionID: string } }).properties.sessionID;
      const state = store.get(sessionID);
      const rule = evaluateReminder(state);
      if (!rule) return;
      state.remindedFor.add(rule.id);
      state.pendingReminder = rule.text;
      state.didCommitSinceLastReminder = false;
      state.didPushOrOpenPr = false;
      state.didDeployCommand = false;
    },

    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input.sessionID;
      if (!sessionID) return;
      const state = store.get(sessionID);
      if (!state.pendingReminder) return;
      output.system.push(`## AI Task Tracker reminder\n${state.pendingReminder}`);
      state.pendingReminder = null;
    },
  };
};

export default AiTaskTrackerNudge;
