import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installCodexHooks,
  installCodexNotifyBridge,
  uninstallCodexHooks,
} from "../src/agents/codex.js";

const fixturePath = join(process.cwd(), "test", "fixtures", "codex", "config.toml");

afterEach(() => {
  delete process.env.RECALL_CLI_PATH;
  delete process.env.RECALL_NODE_PATH;
});

beforeEach(() => {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
});

function makeConfigDir() {
  const tempDir = mkdtempSync(join(tmpdir(), "recall-codex-hooks-json-"));
  const configDir = join(tempDir, ".codex");
  const configPath = join(configDir, "config.toml");
  const hooksPath = join(configDir, "hooks.json");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, readFileSync(fixturePath, "utf-8"));
  return { configDir, configPath, hooksPath };
}

describe("Codex hooks.json adapter", () => {
  it("writes hooks.json with SessionStart, UserPromptSubmit, and PostToolUse entries", () => {
    const { configPath, hooksPath } = makeConfigDir();

    const result = installCodexHooks({
      configPath,
      hooksPath,
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
      forceHooks: true,
    });

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(existsSync(hooksPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(hooksPath, "utf-8"));
    expect(Object.keys(parsed.hooks).sort()).toEqual([
      "PostToolUse",
      "SessionStart",
      "UserPromptSubmit",
    ]);
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toContain("--codex-stdin");
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toContain("recall:managed:codex:prompt");
    expect(parsed.hooks.PostToolUse[0].matcher).toBe("Bash");
  });

  it("enables codex_hooks feature flag under [features] when already present", () => {
    const { configPath, hooksPath } = makeConfigDir();
    installCodexHooks({
      configPath,
      hooksPath,
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
      forceHooks: true,
    });

    const config = readFileSync(configPath, "utf-8");
    expect(config).toMatch(/codex_hooks\s*=\s*true/);
    // should have been injected under the existing [features] block, not duplicated
    expect(config.match(/\[features\]/g)?.length ?? 0).toBe(1);
    expect(config).toContain("# recall:managed:codex:feature");
  });

  it("adds a [features] block when none exists", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "recall-codex-hooks-json-"));
    const configDir = join(tempDir, ".codex");
    const configPath = join(configDir, "config.toml");
    const hooksPath = join(configDir, "hooks.json");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, `model = "gpt-5.4"\n`);

    installCodexHooks({
      configPath,
      hooksPath,
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
      forceHooks: true,
    });

    const config = readFileSync(configPath, "utf-8");
    expect(config).toMatch(/\[features\]\ncodex_hooks = true/);
  });

  it("is idempotent on repeated installs", () => {
    const { configPath, hooksPath } = makeConfigDir();
    installCodexHooks({
      configPath,
      hooksPath,
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
      forceHooks: true,
    });

    const second = installCodexHooks({
      configPath,
      hooksPath,
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
      forceHooks: true,
    });
    expect(second.changed).toBe(false);
  });

  it("removes hooks.json entries and feature flag on uninstall", () => {
    const { configPath, hooksPath } = makeConfigDir();
    installCodexHooks({
      configPath,
      hooksPath,
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
      forceHooks: true,
    });

    const result = uninstallCodexHooks({ configPath, hooksPath });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);

    const parsed = JSON.parse(readFileSync(hooksPath, "utf-8"));
    expect(parsed.hooks ?? {}).toEqual({});

    const config = readFileSync(configPath, "utf-8");
    expect(config).not.toMatch(/codex_hooks\s*=\s*true/);
  });

  it("migrates off legacy notify bridge on install", () => {
    const { configPath, hooksPath } = makeConfigDir();

    installCodexNotifyBridge({
      configPath,
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
    });
    expect(readFileSync(configPath, "utf-8")).toContain("codex-notify");

    installCodexHooks({
      configPath,
      hooksPath,
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
      forceHooks: true,
    });

    const config = readFileSync(configPath, "utf-8");
    expect(config).not.toContain("codex-notify");
    expect(config).toMatch(/codex_hooks\s*=\s*true/);
  });

  it("preserves user hooks in hooks.json that aren't managed by Recall", () => {
    const { configPath, hooksPath } = makeConfigDir();
    writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "echo user-hook" }] },
        ],
      },
    }, null, 2));

    installCodexHooks({
      configPath,
      hooksPath,
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
      forceHooks: true,
    });

    const parsed = JSON.parse(readFileSync(hooksPath, "utf-8"));
    const commands = parsed.hooks.UserPromptSubmit.flatMap(
      (g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command),
    );
    expect(commands).toContain("echo user-hook");
    expect(commands.some((c: string) => c.includes("recall:managed:codex:prompt"))).toBe(true);
  });

  it("only strips recall-managed entries, leaving user hooks intact on uninstall", () => {
    const { configPath, hooksPath } = makeConfigDir();
    writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "echo user-hook" }] },
        ],
      },
    }, null, 2));
    installCodexHooks({
      configPath,
      hooksPath,
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
      forceHooks: true,
    });

    uninstallCodexHooks({ configPath, hooksPath });

    const parsed = JSON.parse(readFileSync(hooksPath, "utf-8"));
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toBe("echo user-hook");
  });
});
