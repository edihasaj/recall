import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  compareSemver,
  extractSemverFromVersionString,
  installCodexHooks,
  uninstallCodexHooks,
} from "../src/agents/codex.js";

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(saved)) {
    process.env[key] = value;
  }
});

beforeEach(() => {
  delete process.env.RECALL_CLI_PATH;
  delete process.env.RECALL_NODE_PATH;
  delete process.env.RECALL_CODEX_HOOKS_MIN_VERSION;
});

function makeConfigDir(initialToml = 'model = "gpt-5.4"\n') {
  const tempDir = mkdtempSync(join(tmpdir(), "recall-codex-probe-"));
  const configDir = join(tempDir, ".codex");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.toml");
  const hooksPath = join(configDir, "hooks.json");
  writeFileSync(configPath, initialToml);
  return { configPath, hooksPath };
}

function stubCodexBinary(version: string): string {
  const binDir = mkdtempSync(join(tmpdir(), "recall-codex-bin-"));
  const script = join(binDir, "codex");
  writeFileSync(script, `#!/usr/bin/env bash\necho "codex-cli ${version}"\n`);
  require("node:fs").chmodSync(script, 0o755);
  return binDir;
}

describe("compareSemver", () => {
  it("orders versions numerically", () => {
    expect(compareSemver("0.115.0", "0.115.0")).toBe(0);
    expect(compareSemver("0.114.9", "0.115.0")).toBe(-1);
    expect(compareSemver("0.122.0", "0.115.0")).toBe(1);
    expect(compareSemver("1.0.0", "0.122.0")).toBe(1);
  });
});

describe("extractSemverFromVersionString", () => {
  it("parses common codex --version outputs", () => {
    expect(extractSemverFromVersionString("codex-cli 0.122.0")).toBe("0.122.0");
    expect(extractSemverFromVersionString("codex 0.115.0-alpha.3")).toBe("0.115.0");
    expect(extractSemverFromVersionString("version 1.2.3")).toBe("1.2.3");
    expect(extractSemverFromVersionString("nope")).toBeNull();
  });
});

describe("installCodexHooks — version-aware fallback", () => {
  it("writes hooks.json when forceHooks is true (skips probe)", () => {
    const { configPath, hooksPath } = makeConfigDir();
    process.env.PATH = "/nonexistent";

    const result = installCodexHooks({
      configPath,
      hooksPath,
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
      forceHooks: true,
    });
    expect(result.ok).toBe(true);
    expect(existsSync(hooksPath)).toBe(true);
    expect(readFileSync(configPath, "utf-8")).toMatch(/codex_hooks\s*=\s*true/);
  });

  it("falls back to the notify bridge when codex is not on PATH", () => {
    const { configPath, hooksPath } = makeConfigDir();
    process.env.PATH = "/nonexistent";

    const result = installCodexHooks({
      configPath,
      hooksPath,
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
    });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/notify bridge/);
    expect(existsSync(hooksPath)).toBe(false);
    const config = readFileSync(configPath, "utf-8");
    expect(config).toMatch(/notify\s*=\s*\[/);
    expect(config).not.toMatch(/codex_hooks\s*=\s*true/);
  });

  it("falls back to the notify bridge when codex is older than the minimum", () => {
    const { configPath, hooksPath } = makeConfigDir();
    const binDir = stubCodexBinary("0.100.0");
    process.env.PATH = `${binDir}:${process.env.PATH}`;

    const result = installCodexHooks({
      configPath,
      hooksPath,
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
    });
    expect(result.message).toMatch(/notify bridge/);
    expect(result.message).toMatch(/0\.100\.0/);
    expect(existsSync(hooksPath)).toBe(false);
    uninstallCodexHooks({ configPath, hooksPath });
  });

  it("writes hooks.json when codex is at or above the minimum version", () => {
    const { configPath, hooksPath } = makeConfigDir();
    const binDir = stubCodexBinary("0.122.0");
    process.env.PATH = `${binDir}:${process.env.PATH}`;

    const result = installCodexHooks({
      configPath,
      hooksPath,
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
    });
    expect(result.message).toMatch(/0\.122\.0/);
    expect(result.message).not.toMatch(/notify bridge/);
    expect(existsSync(hooksPath)).toBe(true);
  });

  it("respects RECALL_CODEX_HOOKS_MIN_VERSION override", () => {
    const { configPath, hooksPath } = makeConfigDir();
    const binDir = stubCodexBinary("0.122.0");
    process.env.PATH = `${binDir}:${process.env.PATH}`;
    process.env.RECALL_CODEX_HOOKS_MIN_VERSION = "99.0.0";

    const result = installCodexHooks({
      configPath,
      hooksPath,
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
    });
    expect(result.message).toMatch(/notify bridge/);
    expect(existsSync(hooksPath)).toBe(false);
  });
});
