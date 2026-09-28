import { describe, expect, it } from "vitest";
import { hasCommand } from "../src/agents/utils.js";

describe("agent CLI detection", () => {
  it("finds executables on the current platform's PATH", () => {
    expect(hasCommand("node")).toBe(true);
    expect(hasCommand("recall-command-that-does-not-exist-9e3a2f")).toBe(false);
  });
});
