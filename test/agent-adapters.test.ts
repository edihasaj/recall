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
  it("lists the available adapters including v2 stubs", () => {
    expect(listAgentNames()).toEqual(["claude-code", "codex", "gemini-cli", "qwen"]);
  });

  it("resolves known adapters", () => {
    expect(resolveAdapter("claude-code").name).toBe("claude-code");
    expect(resolveAdapter("codex").name).toBe("codex");
    expect(resolveAdapter("gemini-cli").name).toBe("gemini-cli");
    expect(resolveAdapter("qwen").name).toBe("qwen");
  });

  it("throws on unknown adapters", () => {
    expect(() => resolveAdapter("cursor")).toThrow(
      "Unknown agent adapter: cursor. Supported adapters: claude-code, codex, gemini-cli, qwen. Reserved v2 stubs: gemini-cli, qwen.",
    );
  });

  it("filters installed adapters via detect()", () => {
    const claude = resolveAdapter("claude-code");
    const codex = resolveAdapter("codex");
    const gemini = resolveAdapter("gemini-cli");
    const qwen = resolveAdapter("qwen");

    vi.spyOn(claude, "detect").mockReturnValue("installed");
    vi.spyOn(codex, "detect").mockReturnValue("not-installed");
    vi.spyOn(gemini, "detect").mockReturnValue("not-installed");
    vi.spyOn(qwen, "detect").mockReturnValue("not-installed");

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
