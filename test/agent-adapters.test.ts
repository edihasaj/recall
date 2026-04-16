import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectInstalledAdapters,
  listAgentNames,
  resolveAdapter,
} from "../src/agents/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent adapter resolver", () => {
  it("lists the phase 1 adapters", () => {
    expect(listAgentNames()).toEqual(["claude-code", "codex"]);
  });

  it("resolves known adapters", () => {
    expect(resolveAdapter("claude-code").name).toBe("claude-code");
    expect(resolveAdapter("codex").name).toBe("codex");
  });

  it("throws on unknown adapters", () => {
    expect(() => resolveAdapter("gemini-cli")).toThrow(
      "Unknown agent adapter: gemini-cli. Supported adapters: claude-code, codex",
    );
  });

  it("filters installed adapters via detect()", () => {
    const claude = resolveAdapter("claude-code");
    const codex = resolveAdapter("codex");

    vi.spyOn(claude, "detect").mockReturnValue("installed");
    vi.spyOn(codex, "detect").mockReturnValue("not-installed");

    expect(detectInstalledAdapters().map((adapter) => adapter.name)).toEqual(["claude-code"]);
  });
});
