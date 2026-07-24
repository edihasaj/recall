import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRecallSetup } from "../src/setup/local.js";

function makeApp(root: string) {
  const runtimeRoot = join(root, "Contents", "Resources", "Runtime");
  mkdirSync(join(runtimeRoot, "bin"), { recursive: true });
  mkdirSync(join(runtimeRoot, "dist"), { recursive: true });
  writeFileSync(join(runtimeRoot, "bin", "node"), "");
  writeFileSync(join(runtimeRoot, "dist", "cli.js"), "");
  writeFileSync(join(runtimeRoot, "dist", "mcp.js"), "");
  return {
    nodePath: join(runtimeRoot, "bin", "node"),
    mcpPath: join(runtimeRoot, "dist", "mcp.js"),
  };
}

/**
 * Runs setup against a throwaway HOME with only the requested agent markers
 * present, and an empty PATH so no real agent CLI is discovered.
 */
function withFakeHome<T>(markerDirs: string[], run: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "recall-hookless-home-"));
  for (const dir of markerDirs) {
    mkdirSync(join(home, dir), { recursive: true });
  }

  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = "/nonexistent-recall-test-bin";
  try {
    return run(home);
  } finally {
    process.env.HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}

describe("recall setup wiring for hookless agents", () => {
  it("detects Cursor and Windsurf, registers MCP, and installs rules", () => {
    const appPath = join(mkdtempSync(join(tmpdir(), "recall-app-")), "Recall.app");
    const runtime = makeApp(appPath);
    const project = mkdtempSync(join(tmpdir(), "recall-project-"));

    withFakeHome([".cursor", ".codeium/windsurf"], (home) => {
      const result = runRecallSetup({ appPath, cwd: project });
      const names = result.agents.map((agent) => agent.agent);
      expect(names).toContain("cursor");
      expect(names).toContain("windsurf");
      // Nothing else is installed in the fake HOME.
      expect(names).not.toContain("claude-code");
      expect(names).not.toContain("codex");

      const cursor = result.agents.find((agent) => agent.agent === "cursor")!;
      expect(cursor.detected).toBe(true);
      expect(cursor.mcp.ok).toBe(true);
      // No hook API — the hooks step is reported as skipped, not failed.
      expect(cursor.hooks.enabled).toBe(false);
      expect(cursor.hooks.message).toMatch(/no hook API/);
      expect(cursor.hook_config_path).toBeNull();
      expect(cursor.rules?.ok).toBe(true);

      const cursorMcp = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf-8"));
      expect(cursorMcp.mcpServers.recall).toEqual({
        command: runtime.nodePath,
        args: [runtime.mcpPath],
        env: {},
      });

      const windsurfMcp = JSON.parse(
        readFileSync(join(home, ".codeium", "windsurf", "mcp_config.json"), "utf-8"),
      );
      expect(windsurfMcp.mcpServers.recall.args).toEqual([runtime.mcpPath]);

      // Cursor rules are project-scoped; Windsurf's are user-global.
      const cursorRules = readFileSync(join(project, ".cursor", "rules", "recall.mdc"), "utf-8");
      expect(cursorRules).toContain("alwaysApply: true");
      expect(cursorRules).toContain("capture_correction");
      expect(
        readFileSync(join(home, ".codeium", "windsurf", "memories", "global_rules.md"), "utf-8"),
      ).toContain("recall:managed:memory:begin");
    });
  });

  it("writes nothing on --dry-run", () => {
    const appPath = join(mkdtempSync(join(tmpdir(), "recall-app-")), "Recall.app");
    makeApp(appPath);
    const project = mkdtempSync(join(tmpdir(), "recall-project-"));

    withFakeHome([".cursor"], (home) => {
      const result = runRecallSetup({ appPath, cwd: project, dryRun: true });
      const cursor = result.agents.find((agent) => agent.agent === "cursor")!;

      expect(cursor.mcp.message).toMatch(/would register/);
      expect(cursor.rules?.message).toMatch(/would install/);
      expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
      expect(existsSync(join(project, ".cursor", "rules", "recall.mdc"))).toBe(false);
    });
  });

  it("--uninstall-hooks strips the rules block and leaves MCP registered", () => {
    const appPath = join(mkdtempSync(join(tmpdir(), "recall-app-")), "Recall.app");
    makeApp(appPath);
    const project = mkdtempSync(join(tmpdir(), "recall-project-"));

    withFakeHome([".cursor"], (home) => {
      runRecallSetup({ appPath, cwd: project });
      const rulesPath = join(project, ".cursor", "rules", "recall.mdc");
      expect(existsSync(rulesPath)).toBe(true);

      runRecallSetup({ appPath, cwd: project, uninstallHooks: true });

      expect(existsSync(rulesPath)).toBe(false);
      const cursorMcp = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf-8"));
      expect(cursorMcp.mcpServers.recall).toBeDefined();
    });
  });

  it("--mcp-only skips the rules step", () => {
    const appPath = join(mkdtempSync(join(tmpdir(), "recall-app-")), "Recall.app");
    makeApp(appPath);
    const project = mkdtempSync(join(tmpdir(), "recall-project-"));

    withFakeHome([".cursor"], () => {
      const result = runRecallSetup({ appPath, cwd: project, mcpOnly: true });
      const cursor = result.agents.find((agent) => agent.agent === "cursor")!;
      expect(cursor.mcp.ok).toBe(true);
      expect(cursor.rules).toBeUndefined();
      expect(existsSync(join(project, ".cursor", "rules", "recall.mdc"))).toBe(false);
    });
  });
});
