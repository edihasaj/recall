import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installClaudeCodeHooks,
  uninstallClaudeCodeHooks,
} from "../src/agents/claude-code.js";

const fixturePath = join(process.cwd(), "test", "fixtures", "claude", "settings.json");

afterEach(() => {
  delete process.env.RECALL_CLI_PATH;
  delete process.env.RECALL_NODE_PATH;
});

describe("phase 3 Claude Code adapter", () => {
  it("installs Recall-managed hooks into settings.json without touching unrelated entries", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "recall-claude-phase3-"));
    const configDir = join(tempDir, ".claude");
    const configPath = join(configDir, "settings.json");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, readFileSync(fixturePath, "utf-8"));

    const result = installClaudeCodeHooks({
      configPath,
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
    });

    expect(result.changed).toBe(true);
    expect(result.config_path).toBe(configPath);

    const files = readdirSync(configDir);
    const backupName = files.find((name) => name.startsWith("settings.json.recall.bak."));
    expect(backupName).toBeTruthy();
    expect(existsSync(join(configDir, backupName!))).toBe(true);

    const settings = JSON.parse(readFileSync(configPath, "utf-8")) as {
      hooks: Record<string, Array<Record<string, unknown>>>;
      permissions: { allow: string[] };
    };

    expect(settings.permissions.allow).toEqual(["Read(**)", "Edit(**)"]);
    expect(settings.hooks.Notification).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.PostToolUse).toHaveLength(2);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionEnd).toHaveLength(1);

    const promptHook = settings.hooks.UserPromptSubmit[0]!.hooks as Array<Record<string, unknown>>;
    expect(promptHook[0]!.command).toContain("hook prompt --agent claude-code --claude-code-stdin");
    expect(promptHook[0]!.command).toContain("recall:managed:claude-code:prompt");

    const managedPostToolGroup = settings.hooks.PostToolUse.find(
      (group) => group.matcher === "Edit|Write|Bash",
    );
    expect(managedPostToolGroup).toBeTruthy();

    const second = installClaudeCodeHooks({
      configPath,
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
    });
    expect(second.changed).toBe(false);
    expect(readdirSync(configDir).filter((name) => name.startsWith("settings.json.recall.bak."))).toHaveLength(1);
  });

  it("removes only Recall-managed Claude hooks on uninstall", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "recall-claude-phase3-"));
    const configDir = join(tempDir, ".claude");
    const configPath = join(configDir, "settings.json");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, readFileSync(fixturePath, "utf-8"));

    installClaudeCodeHooks({
      configPath,
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
    });

    const result = uninstallClaudeCodeHooks({ configPath });
    expect(result.changed).toBe(true);

    const settings = JSON.parse(readFileSync(configPath, "utf-8")) as {
      hooks: Record<string, Array<Record<string, unknown>>>;
    };

    expect(settings.hooks.Notification).toHaveLength(1);
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.PostToolUse[0]!.matcher).toBe("Write");
    expect(settings.hooks.UserPromptSubmit).toBeUndefined();
    expect(settings.hooks.SessionStart).toBeUndefined();
    expect(settings.hooks.SessionEnd).toBeUndefined();
  });
});
