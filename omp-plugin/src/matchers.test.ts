import { describe, it, expect } from "vitest";
import {
  isCommitCommand,
  isPushOrPrCommand,
  isDeployCommand,
  isPlanOrSpecPath,
  extractTrackerToolName,
  toolNameIncludes,
} from "./matchers";

describe("isCommitCommand", () => {
  it("matches a plain git commit", () => {
    expect(isCommitCommand('git commit -m "feat: x"')).toBe(true);
  });

  it("matches git commit chained after other commands", () => {
    expect(isCommitCommand('git add . && git commit -m "x"')).toBe(true);
  });

  it("does not match unrelated commands", () => {
    expect(isCommitCommand("git status")).toBe(false);
  });
});

describe("isPushOrPrCommand", () => {
  it("matches git push", () => {
    expect(isPushOrPrCommand("git push origin master")).toBe(true);
  });

  it("matches gh pr create", () => {
    expect(isPushOrPrCommand("gh pr create --fill")).toBe(true);
  });

  it("does not match git pull", () => {
    expect(isPushOrPrCommand("git pull")).toBe(false);
  });
});

describe("isDeployCommand", () => {
  it("matches a command mentioning deploy", () => {
    expect(isDeployCommand("npm run deploy")).toBe(true);
  });

  it("matches docker push", () => {
    expect(isDeployCommand("docker push registry/app:latest")).toBe(true);
  });

  it("does not match an unrelated command", () => {
    expect(isDeployCommand("git status")).toBe(false);
  });
});

describe("isPlanOrSpecPath", () => {
  it("matches a spec path", () => {
    expect(isPlanOrSpecPath("docs/superpowers/specs/2026-08-28-x-design.md")).toBe(true);
  });

  it("matches a plan path", () => {
    expect(isPlanOrSpecPath("docs/superpowers/plans/2026-08-28-x.md")).toBe(true);
  });

  it("does not match an unrelated markdown file", () => {
    expect(isPlanOrSpecPath("README.md")).toBe(false);
  });
});

describe("extractTrackerToolName", () => {
  it("extracts the tool name from a prefixed MCP tool id", () => {
    expect(extractTrackerToolName("mcp_Ai-task-tracker_create_task")).toBe("create_task");
  });

  it("extracts the tool name without an mcp_ prefix", () => {
    expect(extractTrackerToolName("ai-task-tracker_transition_task_status")).toBe(
      "transition_task_status",
    );
  });

  it("returns null for unrelated tools", () => {
    expect(extractTrackerToolName("bash")).toBeNull();
  });
});

describe("toolNameIncludes", () => {
  it("matches case-insensitively", () => {
    expect(toolNameIncludes("mcp_Bash", "bash")).toBe(true);
  });

  it("returns false when absent", () => {
    expect(toolNameIncludes("mcp_Edit", "bash")).toBe(false);
  });
});
