import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cursorAdapter, cursorGlobalMcpPath, cursorProjectMcpPath, cursorRulesPath } from "../src/agents/cursor.js";
import { githubCopilotAdapter, copilotInstructionsPath, copilotMcpConfigPath } from "../src/agents/github-copilot.js";
import { opencodeAdapter } from "../src/agents/opencode.js";
import { windsurfAdapter } from "../src/agents/windsurf.js";
import type { AgentAdapter } from "../src/agents/types.js";

const NODE_PATH = "/opt/recall/bin/node";
const MCP_PATH = "/opt/recall/dist/mcp.js";

function workdir(label: string): string {
  return mkdtempSync(join(tmpdir(), `recall-${label}-`));
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

const HOOKLESS: Array<[string, AgentAdapter]> = [
  ["github-copilot", githubCopilotAdapter],
  ["opencode", opencodeAdapter],
  ["cursor", cursorAdapter],
  ["windsurf", windsurfAdapter],
];

describe("hookless adapter capabilities", () => {
  it.each(HOOKLESS)("%s advertises MCP-only integration", (_name, adapter) => {
    const caps = adapter.capabilities();
    expect(caps.supports_hook_install).toBe(false);
    expect(caps.supports_mcp_fallback).toBe(true);
    expect(caps.supports).toEqual([]);
  });

  it.each(HOOKLESS)("%s reports instead of throwing when hooks are requested", (_name, adapter) => {
    const result = adapter.installHooks([]);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no hook API/);
    // Uninstall stays a no-op success so `recall setup --uninstall-hooks` is safe.
    expect(adapter.uninstallHooks().ok).toBe(true);
  });

  it.each(HOOKLESS)("%s exposes rules install/uninstall/check", (_name, adapter) => {
    expect(typeof adapter.installRules).toBe("function");
    expect(typeof adapter.uninstallRules).toBe("function");
    expect(typeof adapter.checkRules).toBe("function");
  });

  it("refuses to write an MCP entry without a resolvable entrypoint", () => {
    const configPath = join(workdir("no-mcp-path"), "mcp.json");
    const result = cursorAdapter.writeMcpFallback({ configPath, nodePath: NODE_PATH });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/RECALL_MCP_PATH/);
    expect(existsSync(configPath)).toBe(false);
  });
});

describe("MCP JSON registration dialects", () => {
  it("writes the Copilot CLI shape (type/command/args/env/tools)", () => {
    const configPath = join(workdir("copilot"), "mcp-config.json");
    const result = githubCopilotAdapter.writeMcpFallback({
      configPath,
      nodePath: NODE_PATH,
      mcpPath: MCP_PATH,
    });

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(readJson(configPath).mcpServers.recall).toEqual({
      type: "local",
      command: NODE_PATH,
      args: [MCP_PATH],
      env: {},
      tools: ["*"],
    });
  });

  it("writes the opencode shape — servers under `mcp` with an argv array", () => {
    const configPath = join(workdir("opencode"), "opencode.json");
    opencodeAdapter.writeMcpFallback({ configPath, nodePath: NODE_PATH, mcpPath: MCP_PATH });

    const parsed = readJson(configPath);
    expect(parsed.mcpServers).toBeUndefined();
    expect(parsed.mcp.recall).toEqual({
      type: "local",
      command: [NODE_PATH, MCP_PATH],
      enabled: true,
    });
  });

  it.each([
    ["cursor", cursorAdapter],
    ["windsurf", windsurfAdapter],
  ] as Array<[string, AgentAdapter]>)("writes the Claude Desktop shape for %s", (name, adapter) => {
    const configPath = join(workdir(name), "mcp.json");
    adapter.writeMcpFallback({ configPath, nodePath: NODE_PATH, mcpPath: MCP_PATH });

    expect(readJson(configPath).mcpServers.recall).toEqual({
      command: NODE_PATH,
      args: [MCP_PATH],
      env: {},
    });
  });

  it("preserves unrelated config and backs up the previous file", () => {
    const dir = workdir("preserve");
    const configPath = join(dir, "opencode.json");
    writeFileSync(
      configPath,
      JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "anthropic/claude", mcp: { other: { type: "local", command: ["other"] } } }, null, 2),
    );

    opencodeAdapter.writeMcpFallback({ configPath, nodePath: NODE_PATH, mcpPath: MCP_PATH });

    const parsed = readJson(configPath);
    expect(parsed.$schema).toBe("https://opencode.ai/config.json");
    expect(parsed.model).toBe("anthropic/claude");
    expect(parsed.mcp.other).toEqual({ type: "local", command: ["other"] });
    expect(parsed.mcp.recall).toBeDefined();
    expect(readdirSync(dir).some((f) => f.includes(".recall.bak."))).toBe(true);
  });

  it("is idempotent — a second write reports no change", () => {
    const configPath = join(workdir("idempotent"), "mcp.json");
    const opts = { configPath, nodePath: NODE_PATH, mcpPath: MCP_PATH };

    expect(windsurfAdapter.writeMcpFallback(opts).changed).toBe(true);
    const second = windsurfAdapter.writeMcpFallback(opts);
    expect(second.changed).toBe(false);
    expect(second.ok).toBe(true);
  });

  it("removes the recall entry and drops an emptied container", () => {
    const configPath = join(workdir("remove"), "mcp.json");
    const opts = { configPath, nodePath: NODE_PATH, mcpPath: MCP_PATH };
    githubCopilotAdapter.writeMcpFallback(opts);

    const removed = githubCopilotAdapter.removeMcpFallback!({ configPath });
    expect(removed.changed).toBe(true);
    expect(readJson(configPath).mcpServers).toBeUndefined();

    // Removing twice is a no-op, not an error.
    expect(githubCopilotAdapter.removeMcpFallback!({ configPath }).changed).toBe(false);
  });

  it("keeps other servers when removing recall", () => {
    const configPath = join(workdir("remove-partial"), "mcp.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    githubCopilotAdapter.writeMcpFallback({ configPath, nodePath: NODE_PATH, mcpPath: MCP_PATH });
    githubCopilotAdapter.removeMcpFallback!({ configPath });

    expect(readJson(configPath).mcpServers).toEqual({ other: { command: "x" } });
  });

  it("refuses to rewrite a config it cannot parse", () => {
    const configPath = join(workdir("jsonc"), "opencode.jsonc");
    const original = '{\n  // a comment breaks JSON.parse\n  "mcp": {}\n}\n';
    writeFileSync(configPath, original);

    const result = opencodeAdapter.writeMcpFallback({
      configPath,
      nodePath: NODE_PATH,
      mcpPath: MCP_PATH,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Could not parse/);
    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });
});

describe("managed rules blocks", () => {
  it("appends to an existing instructions file without clobbering it", () => {
    const cwd = workdir("copilot-rules");
    const target = copilotInstructionsPath({ cwd });
    mkdirSync(join(cwd, ".github"), { recursive: true });
    writeFileSync(target, "# House rules\n\nUse tabs.\n");

    const result = githubCopilotAdapter.installRules!({ cwd });
    expect(result.ok).toBe(true);
    expect(result.config_path).toBe(target);

    const content = readFileSync(target, "utf-8");
    expect(content).toContain("# House rules");
    expect(content).toContain("Use tabs.");
    expect(content).toContain("recall:managed:memory:begin v1");
    expect(content).toContain("capture_correction");
  });

  it("is idempotent and reports status", () => {
    const cwd = workdir("copilot-rules-idempotent");
    expect(githubCopilotAdapter.checkRules!({ cwd }).status).toBe("absent_no_file");

    expect(githubCopilotAdapter.installRules!({ cwd }).changed).toBe(true);
    expect(githubCopilotAdapter.checkRules!({ cwd }).status).toBe("current");
    expect(githubCopilotAdapter.installRules!({ cwd }).changed).toBe(false);
  });

  it("replaces a stale block in place rather than appending a second copy", () => {
    const cwd = workdir("copilot-rules-stale");
    const target = copilotInstructionsPath({ cwd });
    mkdirSync(join(cwd, ".github"), { recursive: true });
    writeFileSync(
      target,
      "Keep me.\n\n<!-- recall:managed:memory:begin v0 -->\nold body\n<!-- recall:managed:memory:end -->\n",
    );

    expect(githubCopilotAdapter.checkRules!({ cwd }).status).toBe("stale");
    githubCopilotAdapter.installRules!({ cwd });

    const content = readFileSync(target, "utf-8");
    expect(content).toContain("Keep me.");
    expect(content).not.toContain("old body");
    expect(content.match(/recall:managed:memory:begin/g)).toHaveLength(1);
  });

  it("strips the block on uninstall but leaves user content", () => {
    const cwd = workdir("copilot-rules-uninstall");
    const target = copilotInstructionsPath({ cwd });
    mkdirSync(join(cwd, ".github"), { recursive: true });
    writeFileSync(target, "# House rules\n");

    githubCopilotAdapter.installRules!({ cwd });
    const removed = githubCopilotAdapter.uninstallRules!({ cwd });

    expect(removed.changed).toBe(true);
    const content = readFileSync(target, "utf-8");
    expect(content).toContain("# House rules");
    expect(content).not.toContain("recall:managed:memory");
  });

  it("writes Cursor rules as an owned .mdc with frontmatter and deletes it on uninstall", () => {
    const cwd = workdir("cursor-rules");
    const target = cursorRulesPath({ cwd });

    cursorAdapter.installRules!({ cwd });

    const content = readFileSync(target, "utf-8");
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("alwaysApply: true");
    expect(content).toContain("recall:managed:memory:begin v1");

    cursorAdapter.uninstallRules!({ cwd });
    expect(existsSync(target)).toBe(false);
  });

  it("uninstall is a no-op when nothing was installed", () => {
    const cwd = workdir("rules-noop");
    const result = githubCopilotAdapter.uninstallRules!({ cwd });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
  });
});

describe("adapter config paths", () => {
  it("points Copilot at ~/.copilot/mcp-config.json and honours COPILOT_HOME", () => {
    expect(copilotMcpConfigPath()).toMatch(/\.copilot\/mcp-config\.json$/);

    const previous = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = "/custom/copilot";
    try {
      expect(copilotMcpConfigPath()).toBe("/custom/copilot/mcp-config.json");
    } finally {
      if (previous === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = previous;
    }
  });

  it("selects the Cursor project config only when scope is project", () => {
    const cwd = workdir("cursor-scope");
    cursorAdapter.writeMcpFallback({
      scope: "project",
      cwd,
      nodePath: NODE_PATH,
      mcpPath: MCP_PATH,
    });

    expect(existsSync(cursorProjectMcpPath({ cwd }))).toBe(true);
    expect(cursorGlobalMcpPath()).toMatch(/\.cursor\/mcp\.json$/);
    expect(cursorAdapter.configPath()).toBe(cursorGlobalMcpPath());
  });

  it("keeps opencode and windsurf rules user-global, Copilot and Cursor project-scoped", () => {
    expect(opencodeAdapter.rulesScope).toBe("global");
    expect(windsurfAdapter.rulesScope).toBe("global");
    expect(githubCopilotAdapter.rulesScope).toBe("project");
    expect(cursorAdapter.rulesScope).toBe("project");
  });
});
