import { describe, expect, it } from "vitest";
import { readTrackerConfig } from "./config";

const completeEnv = {
  AI_TRACKER_URL: "https://tracker.example/",
  AI_TRACKER_API_KEY: "secret-key",
  AI_TRACKER_QUEUE_PATH: "/tmp/tracker-queue.json",
};

describe("readTrackerConfig", () => {
  it("returns trimmed, normalized enabled configuration", () => {
    expect(readTrackerConfig(completeEnv)).toEqual({
      enabled: true,
      baseUrl: "https://tracker.example",
      apiKey: "secret-key",
      queuePath: "/tmp/tracker-queue.json",
      author: "opencode",
    });
  });

  it("removes repeated trailing slashes from HTTP(S) URLs only", () => {
    expect(
      readTrackerConfig({
        ...completeEnv,
        AI_TRACKER_URL: "  https://tracker.example/api///  ",
      }),
    ).toMatchObject({ enabled: true, baseUrl: "https://tracker.example/api" });
  });

  it("uses a trimmed explicit log author", () => {
    expect(
      readTrackerConfig({
        ...completeEnv,
        AI_TRACKER_LOG_AUTHOR: "  automation  ",
      }),
    ).toMatchObject({ enabled: true, author: "automation" });
  });

  it.each([
    ["AI_TRACKER_URL", { AI_TRACKER_API_KEY: "secret-key", AI_TRACKER_QUEUE_PATH: "/tmp/queue" }],
    ["AI_TRACKER_API_KEY", { AI_TRACKER_URL: "https://tracker.example", AI_TRACKER_QUEUE_PATH: "/tmp/queue" }],
    ["AI_TRACKER_QUEUE_PATH", { AI_TRACKER_URL: "https://tracker.example", AI_TRACKER_API_KEY: "secret-key" }],
    ["AI_TRACKER_URL", { ...completeEnv, AI_TRACKER_URL: "   " }],
    ["AI_TRACKER_URL", { ...completeEnv, AI_TRACKER_URL: "ftp://tracker.example" }],
  ])("disables logging when %s is missing or invalid", (missing, env) => {
    const config = readTrackerConfig(env);

    expect(config).toEqual({
      enabled: false,
      diagnostic: `AI Task Tracker automatic logging disabled: ${missing} are required.`,
    });
    if (config.enabled) throw new Error("expected disabled configuration");
    expect(config.diagnostic).not.toContain("secret-key");
  });

  it("lists multiple unavailable settings in a deterministic order without exposing the API key", () => {
    const config = readTrackerConfig({ AI_TRACKER_API_KEY: "secret-key" });

    expect(config).toEqual({
      enabled: false,
      diagnostic: "AI Task Tracker automatic logging disabled: AI_TRACKER_URL, AI_TRACKER_QUEUE_PATH are required.",
    });
    if (config.enabled) throw new Error("expected disabled configuration");
    expect(config.diagnostic).not.toContain("secret-key");
  });
});
