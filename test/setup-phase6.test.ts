import { describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
}

function makeAgentStubs(): string {
  const binDir = mkdtempSync(join(tmpdir(), "recall-agent-stub-"));
  writeFileSync(join(binDir, "codex"), `#!/usr/bin/env bash\necho "codex-cli 0.122.0"\n`);
  writeFileSync(join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(binDir, "codex"), 0o755);
  chmodSync(join(binDir, "claude"), 0o755);
  return binDir;
}

describe("phase 6 setup orchestration", () => {
  it("supports dry-run planning for detected global agents", () => {
    const home = mkdtempSync(join(tmpdir(), "recall-setup-home-"));
    const appPath = join(mkdtempSync(join(tmpdir(), "recall-app-")), "Recall.app");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    makeApp(appPath);
    writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5.4"\n');

    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    const stubDir = makeAgentStubs();
    process.env.HOME = home;
    process.env.PATH = `${stubDir}:/usr/bin:/bin`;
    try {
      const result = runRecallSetup({
        appPath,
        dryRun: true,
      });

      expect(result.agents.map((agent) => agent.agent).sort()).toEqual(["claude-code", "codex"]);
      expect(result.agents.every((agent) => agent.detected)).toBe(true);
      expect(result.agents.every((agent) => agent.mcp.message.includes("would configure"))).toBe(true);
      expect(result.agents.every((agent) => agent.hooks.message.includes("would install"))).toBe(true);
    } finally {
      process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("writes project-scoped hook config and skips unsupported project Codex MCP", () => {
    const home = mkdtempSync(join(tmpdir(), "recall-setup-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "recall-setup-cwd-"));
    const appPath = join(mkdtempSync(join(tmpdir(), "recall-app-")), "Recall.app");
    const commands: Array<{ command: string; args: string[] }> = [];
    makeApp(appPath);
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5.4"\n');

    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    const stubDir = makeAgentStubs();
    process.env.HOME = home;
    process.env.PATH = `${stubDir}:/usr/bin:/bin`;
    try {
      const result = runRecallSetup({
        appPath,
        agent: ["claude-code", "codex"],
        cwd,
        runner: (command, args) => {
          commands.push({ command, args });
        },
        scope: "project",
      });

      const codex = result.agents.find((agent) => agent.agent === "codex")!;
      const claude = result.agents.find((agent) => agent.agent === "claude-code")!;

      expect(codex.mcp.message).toContain("project-scoped Codex MCP not supported");
      expect(claude.mcp.message).toContain("configured project Claude MCP server");
      expect(commands).toEqual([
        { command: "claude", args: ["mcp", "remove", "recall", "-s", "project"] },
        {
          command: "claude",
          args: [
            "mcp",
            "add",
            "-s",
            "project",
            "recall",
            join(appPath, "Contents", "Resources", "Runtime", "bin", "node"),
            join(appPath, "Contents", "Resources", "Runtime", "dist", "mcp.js"),
          ],
        },
      ]);

      expect(readFileSync(join(cwd, ".claude", "settings.json"), "utf-8")).toContain("recall:managed:claude-code");
      expect(readFileSync(join(cwd, ".codex", "config.toml"), "utf-8")).toContain("codex_hooks = true");
      expect(readFileSync(join(cwd, ".codex", "hooks.json"), "utf-8")).toContain("recall:managed:codex");
    } finally {
      process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("uninstalls hooks while leaving MCP setup untouched", () => {
    const home = mkdtempSync(join(tmpdir(), "recall-setup-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "recall-setup-cwd-"));
    const appPath = join(mkdtempSync(join(tmpdir(), "recall-app-")), "Recall.app");
    const commands: Array<{ command: string; args: string[] }> = [];
    makeApp(appPath);

    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    const stubDir = makeAgentStubs();
    process.env.HOME = home;
    process.env.PATH = `${stubDir}:/usr/bin:/bin`;
    try {
      runRecallSetup({
        appPath,
        agent: ["claude-code", "codex"],
        cwd,
        runner: () => {},
        scope: "project",
      });

      const result = runRecallSetup({
        appPath,
        agent: ["claude-code", "codex"],
        cwd,
        runner: (command, args) => {
          commands.push({ command, args });
        },
        scope: "project",
        uninstallHooks: true,
      });

      expect(result.agents.every((agent) => agent.hooks.ok)).toBe(true);
      expect(readFileSync(join(cwd, ".claude", "settings.json"), "utf-8")).not.toContain("recall:managed:claude-code");
      expect(readFileSync(join(cwd, ".codex", "config.toml"), "utf-8")).not.toContain("recall:managed:codex:start");
      expect(commands).toEqual([
        { command: "claude", args: ["mcp", "remove", "recall", "-s", "project"] },
        {
          command: "claude",
          args: [
            "mcp",
            "add",
            "-s",
            "project",
            "recall",
            join(appPath, "Contents", "Resources", "Runtime", "bin", "node"),
            join(appPath, "Contents", "Resources", "Runtime", "dist", "mcp.js"),
          ],
        },
      ]);
    } finally {
      process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
