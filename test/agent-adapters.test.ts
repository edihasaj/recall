import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectInstalledAdapters,
  listAgentNames,
  resolveAdapter,
} from "../src/agents/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const ALL_AGENTS = [
  "claude-code",
  "codex",
  "github-copilot",
  "opencode",
  "cursor",
  "windsurf",
  "gemini-cli",
  "qwen",
] as const;

describe("agent adapter resolver", () => {
  it("lists the available adapters including v2 stubs", () => {
    expect(listAgentNames()).toEqual([...ALL_AGENTS]);
  });

  it("resolves known adapters", () => {
    for (const name of ALL_AGENTS) {
      expect(resolveAdapter(name).name).toBe(name);
    }
  });

  it("throws on unknown adapters", () => {
    expect(() => resolveAdapter("aider")).toThrow(
      "Unknown agent adapter: aider. Supported adapters: claude-code, codex, github-copilot, opencode, cursor, windsurf, gemini-cli, qwen. Reserved v2 stubs: gemini-cli, qwen.",
    );
  });

  it("filters installed adapters via detect()", () => {
    for (const name of ALL_AGENTS) {
      vi.spyOn(resolveAdapter(name), "detect").mockReturnValue(
        name === "claude-code" ? "installed" : "not-installed",
      );
    }

    expect(detectInstalledAdapters().map((adapter) => adapter.name)).toEqual(["claude-code"]);
  });

  it("keeps v2 stubs explicit about not being implemented", () => {
    expect(() => resolveAdapter("gemini-cli").installHooks([])).toThrow(
      "Gemini CLI hook installation not implemented yet.",
    );
    expect(() => resolveAdapter("qwen").installHooks([])).toThrow(
      "Qwen hook installation not implemented yet.",
    );
  });
});
