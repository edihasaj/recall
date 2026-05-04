import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLocalSetup } from "../src/setup/local.js";

function makeApp(root: string) {
  const runtimeRoot = join(root, "Contents", "Resources", "Runtime");
  mkdirSync(join(runtimeRoot, "bin"), { recursive: true });
  mkdirSync(join(runtimeRoot, "dist"), { recursive: true });
  writeFileSync(join(runtimeRoot, "bin", "node"), "");
  writeFileSync(join(runtimeRoot, "dist", "cli.js"), "");
  writeFileSync(join(runtimeRoot, "dist", "mcp.js"), "");
}

function makeCodexStub(version: string): string {
  const binDir = mkdtempSync(join(tmpdir(), "recall-codex-stub-"));
  const script = join(binDir, "codex");
  writeFileSync(script, `#!/usr/bin/env bash\necho "codex-cli ${version}"\n`);
  chmodSync(script, 0o755);
  return binDir;
}

describe("runLocalSetup installs both MCP and hooks globally", () => {
  it("wires Claude Code hooks in ~/.claude/settings.json and Codex hooks in ~/.codex/hooks.json", { timeout: 15_000 }, () => {
    const home = mkdtempSync(join(tmpdir(), "recall-local-home-"));
    const appPath = join(mkdtempSync(join(tmpdir(), "recall-app-")), "Recall.app");
    makeApp(appPath);

    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5.4"\n');

    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    process.env.HOME = home;
    // Only a stub `codex` is on PATH so the version probe sees a supported
    // build but real `claude mcp add` / `codex mcp add` still fail cleanly.
    const stubDir = makeCodexStub("0.122.0");
    process.env.PATH = `${stubDir}:/usr/bin:/bin`;
    try {
      const result = runLocalSetup({ appPath });

      // MCP step gets skipped because `claude` / `codex` aren't on PATH in the test — that's fine;
      // the hook step should still have run and written the config files.
      expect(result.codex_hooks.ok).toBe(true);
      expect(result.claude_hooks.ok).toBe(true);

      const claudeSettings = readFileSync(join(home, ".claude", "settings.json"), "utf-8");
      expect(claudeSettings).toContain("recall:managed:claude-code");
      expect(claudeSettings).toMatch(/UserPromptSubmit/);

      const codexConfig = readFileSync(join(home, ".codex", "config.toml"), "utf-8");
      expect(codexConfig).toMatch(/codex_hooks\s*=\s*true/);
      expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(true);
      const codexHooks = readFileSync(join(home, ".codex", "hooks.json"), "utf-8");
      expect(codexHooks).toContain("recall:managed:codex");
      expect(codexHooks).toContain("UserPromptSubmit");
    } finally {
      process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
