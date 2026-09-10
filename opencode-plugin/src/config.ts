export type TrackerConfig = {
  enabled: true;
  baseUrl: string;
  apiKey: string;
  queuePath: string;
  author: string;
};

export type DisabledTrackerConfig = {
  enabled: false;
  diagnostic: string;
};

export function readTrackerConfig(
  env: NodeJS.ProcessEnv = process.env,
): TrackerConfig | DisabledTrackerConfig {
  const baseUrl = normalizeHttpUrl(env.AI_TRACKER_URL);
  const apiKey = trim(env.AI_TRACKER_API_KEY);
  const queuePath = trim(env.AI_TRACKER_QUEUE_PATH);
  const author = trim(env.AI_TRACKER_LOG_AUTHOR) || "opencode";

  const missing = [
    !baseUrl && "AI_TRACKER_URL",
    !apiKey && "AI_TRACKER_API_KEY",
    !queuePath && "AI_TRACKER_QUEUE_PATH",
  ].filter((name): name is string => Boolean(name));

  if (missing.length > 0) {
    return {
      enabled: false,
      diagnostic: `AI Task Tracker automatic logging disabled: ${missing.join(", ")} are required.`,
    };
  }

  return { enabled: true, baseUrl, apiKey, queuePath, author };
}

function trim(value: string | undefined): string {
  return value?.trim() ?? "";
}

function normalizeHttpUrl(value: string | undefined): string {
  const input = trim(value);
  if (!input) return "";

  try {
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}
