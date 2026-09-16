import { describe, expect, it } from "vitest";
import plugin from "./index";

describe("plugin entrypoint", () => {
  it("exports the AI Task Tracker extension factory", () => {
    expect(plugin).toEqual(expect.any(Function));
  });
});
