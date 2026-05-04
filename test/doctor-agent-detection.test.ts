import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectAgentInstalls } from "../src/doctor/report.js";
import { installClaudeCodeHooks } from "../src/agents/claude-code.js";
import { installCodexHooks, installCodexNotifyBridge } from "../src/agents/codex.js";

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), "recall-doctor-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  return home;
}

describe("doctor detects agent install state", () => {
  it("reports not-detected agents cleanly", () => {
    const home = mkdtempSync(join(tmpdir(), "recall-doctor-empty-"));
    const entries = inspectAgentInstalls(home);
    const claude = entries.find((e) => e.agent === "claude-code")!;
    const codex = entries.find((e) => e.agent === "codex")!;
    // detected could still be true if `claude`/`codex` happen to be on PATH, but
    // the key invariant is that with no config files present, hooks/mcp are false.
    expect(claude.mcp).toBe(false);
    expect(claude.hooks).toBe(false);
    expect(codex.mcp).toBe(false);
    expect(codex.hooks).toBe(false);
  });

  it("reports Claude Code MCP+hooks after install", () => {
    const home = freshHome();
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { recall: { command: "node" } } }, null, 2),
    );
    installClaudeCodeHooks({
      configPath: join(home, ".claude", "settings.json"),
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
    });

    const claude = inspectAgentInstalls(home).find((e) => e.agent === "claude-code")!;
    expect(claude.detected).toBe(true);
    expect(claude.mcp).toBe(true);
    expect(claude.hooks).toBe(true);
    expect(claude.notes).toHaveLength(0);
  });

  it("flags Claude Code as hooks-missing when only MCP is configured", () => {
    const home = freshHome();
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { recall: { command: "node" } } }, null, 2),
    );
    const claude = inspectAgentInstalls(home).find((e) => e.agent === "claude-code")!;
    expect(claude.mcp).toBe(true);
    expect(claude.hooks).toBe(false);
    expect(claude.notes.join(" ")).toMatch(/hooks/);
  });

  it("flags a Codex legacy notify bridge as upgrade-required", () => {
    const home = freshHome();
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5.4"\n');
    installCodexNotifyBridge({
      configPath: join(home, ".codex", "config.toml"),
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
    });

    const codex = inspectAgentInstalls(home).find((e) => e.agent === "codex")!;
    expect(codex.legacy_notify_bridge).toBe(true);
    expect(codex.hooks).toBe(false);
  });

  it("reports Codex hooks OK only when both feature flag and hooks.json are present", () => {
    const home = freshHome();
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5.4"\n');

    // No install yet: both flags and hooks.json missing
    let codex = inspectAgentInstalls(home).find((e) => e.agent === "codex")!;
    expect(codex.hooks).toBe(false);

    installCodexHooks({
      configPath: join(home, ".codex", "config.toml"),
      hooksPath: join(home, ".codex", "hooks.json"),
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
      forceHooks: true,
    });

    codex = inspectAgentInstalls(home).find((e) => e.agent === "codex")!;
    expect(codex.hooks).toBe(true);
  });
});
