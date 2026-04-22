import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { program } from "../src/cli.js";
import { runRecallSetup } from "../src/setup/local.js";
import { chdir, cwd as getCwd } from "node:process";

function makeApp(root: string) {
  const runtimeRoot = join(root, "Contents", "Resources", "Runtime");
  mkdirSync(join(runtimeRoot, "bin"), { recursive: true });
  mkdirSync(join(runtimeRoot, "dist"), { recursive: true });
  writeFileSync(join(runtimeRoot, "bin", "node"), "");
  writeFileSync(join(runtimeRoot, "dist", "cli.js"), "");
  writeFileSync(join(runtimeRoot, "dist", "mcp.js"), "");
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  delete process.env.HOME;
  delete process.env.PATH;
});

describe("phase 8 setup uninstall CLI", () => {
  it("removes project hooks via `recall setup --uninstall-hooks`", async () => {
    const home = mkdtempSync(join(tmpdir(), "recall-setup-phase8-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "recall-setup-phase8-cwd-"));
    const appPath = join(mkdtempSync(join(tmpdir(), "recall-app-")), "Recall.app");
    makeApp(appPath);
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5.4"\n');

    process.env.HOME = home;
    process.env.PATH = "";

    runRecallSetup({
      appPath,
      agent: ["claude-code", "codex"],
      cwd,
      runner: () => {},
      scope: "project",
    });

    expect(readFileSync(join(cwd, ".claude", "settings.json"), "utf-8")).toContain("recall:managed:claude-code");
    expect(readFileSync(join(cwd, ".codex", "config.toml"), "utf-8")).toContain("codex_hooks = true");
    expect(readFileSync(join(cwd, ".codex", "hooks.json"), "utf-8")).toContain("recall:managed:codex");

    const logs: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
      logs.push(String(value ?? ""));
    });
    vi.spyOn(console, "error").mockImplementation((value?: unknown) => {
      errors.push(String(value ?? ""));
    });

    const previousCwd = getCwd();
    chdir(cwd);
    try {
      await program.parseAsync([
        "setup",
        "--app-path",
        appPath,
        "--scope",
        "project",
        "--agent",
        "claude-code",
        "--agent",
        "codex",
        "--uninstall-hooks",
        "--yes",
      ], { from: "user" });
    } finally {
      chdir(previousCwd);
    }

    expect(errors).toEqual([]);
    expect(logs.some((line) => line.includes("hooks:"))).toBe(true);
    expect(readFileSync(join(cwd, ".claude", "settings.json"), "utf-8")).not.toContain("recall:managed:claude-code");
    expect(readFileSync(join(cwd, ".codex", "config.toml"), "utf-8")).not.toContain("codex_hooks = true");
    const codexHooks = join(cwd, ".codex", "hooks.json");
    if (existsSync(codexHooks)) {
      expect(readFileSync(codexHooks, "utf-8")).not.toContain("recall:managed:codex");
    }
  });
});
