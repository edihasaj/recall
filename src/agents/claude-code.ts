import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasCommand, resolveUserHomeDir } from "./utils.js";
import type {
  AgentAdapter,
  HookProfile,
  InstallResult,
} from "./types.js";

const CLAUDE_CONFIG_RELATIVE_PATH = [".claude", "settings.json"] as const;
const MANAGED_TAG = "recall:managed:claude-code";
const SESSION_START_MATCHER = "startup|resume|clear|compact";
const SESSION_END_MATCHER =
  "clear|resume|logout|prompt_input_exit|bypass_permissions_disabled|other";

interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookMatcherGroup[]>;
  [key: string]: unknown;
}

interface ClaudeHookMatcherGroup {
  matcher?: string;
  hooks?: ClaudeCommandHook[];
  [key: string]: unknown;
}

interface ClaudeCommandHook {
  type: "command";
  command: string;
  [key: string]: unknown;
}

export interface ClaudeCodeHookInstallOptions {
  configPath?: string;
  cliPath?: string;
  nodePath?: string;
  profile?: HookProfile;
  /** When false, prepends RECALL_HOOK_INJECT_PROMPT=false to the prompt-hook command so per-prompt injection stays off without requiring a shell rc edit. */
  promptInjection?: boolean;
}

const configPath = () => join(resolveUserHomeDir(), ...CLAUDE_CONFIG_RELATIVE_PATH);

export const claudeCodeAdapter: AgentAdapter = {
  name: "claude-code",
  configPath,
  detect() {
    return existsSync(configPath()) || hasCommand("claude") ? "installed" : "not-installed";
  },
  capabilities() {
    return {
      supports: ["session_started", "prompt_submitted", "tool_invoked", "session_ended"],
      supports_hook_install: true,
      supports_mcp_fallback: true,
    };
  },
  installHooks(profile: HookProfile): InstallResult {
    return installClaudeCodeHooks({ profile });
  },
  uninstallHooks(): InstallResult {
    return uninstallClaudeCodeHooks();
  },
  envMapping: {
    prompt_submitted: {
      prompt: "text",
      session_id: "session_id",
      cwd: "repo_path",
    },
    tool_invoked: {
      tool_name: "name",
      tool_input: "input_summary",
      session_id: "session_id",
      cwd: "repo_path",
    },
    session_started: {
      session_id: "session_id",
      cwd: "repo_path",
      source: "matcher",
    },
    session_ended: {
      session_id: "session_id",
      cwd: "repo_path",
      reason: "matcher",
    },
  },
  writeMcpFallback(): InstallResult {
    throw new Error("Claude Code MCP fallback wiring not implemented yet.");
  },
};

export function installClaudeCodeHooks(
  options: ClaudeCodeHookInstallOptions = {},
): InstallResult {
  const targetPath = options.configPath ?? configPath();
  const current = readSettingsFile(targetPath);
  const managedGroups = buildManagedGroups({
    cliPath: options.cliPath,
    nodePath: options.nodePath,
    profile: options.profile,
    promptInjection: options.promptInjection,
  });
  const next = cloneSettings(current.settings);
  const hooks = ensureHooksObject(next);

  let changed = false;
  for (const [eventName, groups] of Object.entries(managedGroups)) {
    const existing = hooks[eventName] ?? [];
    const preserved = existing.filter((group) => !isManagedGroup(group));
    const merged = [...preserved, ...groups];
    if (!sameJson(existing, merged)) {
      hooks[eventName] = merged;
      changed = true;
    }
  }

  if (!changed) {
    return {
      ok: true,
      changed: false,
      config_path: targetPath,
      message: "Claude Code hooks already installed",
    };
  }

  writeSettingsFile(targetPath, current.raw, next);
  return {
    ok: true,
    changed: true,
    config_path: targetPath,
    message: "Installed Claude Code Recall hooks",
  };
}

export function uninstallClaudeCodeHooks(
  options: Pick<ClaudeCodeHookInstallOptions, "configPath"> = {},
): InstallResult {
  const targetPath = options.configPath ?? configPath();
  if (!existsSync(targetPath)) {
    return {
      ok: true,
      changed: false,
      config_path: targetPath,
      message: "Claude Code settings file not found",
    };
  }

  const current = readSettingsFile(targetPath);
  const next = cloneSettings(current.settings);
  const hooks = next.hooks;

  if (!hooks || typeof hooks !== "object") {
    return {
      ok: true,
      changed: false,
      config_path: targetPath,
      message: "No Claude Code hooks configured",
    };
  }

  let changed = false;
  for (const eventName of Object.keys(hooks)) {
    const existing = hooks[eventName] ?? [];
    const preserved = existing.filter((group) => !isManagedGroup(group));
    if (!sameJson(existing, preserved)) {
      changed = true;
      if (preserved.length > 0) {
        hooks[eventName] = preserved;
      } else {
        delete hooks[eventName];
      }
    }
  }

  if (Object.keys(hooks).length === 0) {
    delete next.hooks;
  }

  if (!changed) {
    return {
      ok: true,
      changed: false,
      config_path: targetPath,
      message: "No Recall-managed Claude Code hooks found",
    };
  }

  writeSettingsFile(targetPath, current.raw, next);
  return {
    ok: true,
    changed: true,
    config_path: targetPath,
    message: "Removed Claude Code Recall hooks",
  };
}

function buildManagedGroups(
  options: ClaudeCodeHookInstallOptions,
): Record<string, ClaudeHookMatcherGroup[]> {
  const installedEvents = new Set(options.profile ?? []);
  const commandPrefix = resolveHookCommandPrefix(options);
  const groups: Record<string, ClaudeHookMatcherGroup[]> = {};

  groups.SessionStart = [
    {
      matcher: SESSION_START_MATCHER,
      hooks: [commandHook(`${commandPrefix} hook session-start --agent claude-code --claude-code-stdin`, "session-start")],
    },
  ];

  if (installedEvents.size === 0 || installedEvents.has("prompt_submitted")) {
    const envPrefix = options.promptInjection === false ? "RECALL_HOOK_INJECT_PROMPT=false " : "";
    groups.UserPromptSubmit = [
      {
        hooks: [commandHook(`${envPrefix}${commandPrefix} hook prompt --agent claude-code --claude-code-stdin`, "prompt")],
      },
    ];
  }

  if (installedEvents.size === 0 || installedEvents.has("tool_invoked")) {
    groups.PostToolUse = [
      {
        matcher: "Edit|Write|Bash",
        hooks: [commandHook(`${commandPrefix} hook tool --agent claude-code --claude-code-stdin`, "tool")],
      },
    ];
  }

  if (installedEvents.size === 0 || installedEvents.has("session_ended")) {
    groups.SessionEnd = [
      {
        matcher: SESSION_END_MATCHER,
        hooks: [commandHook(`${commandPrefix} hook session-end --agent claude-code --claude-code-stdin`, "session-end")],
      },
    ];
  }

  return groups;
}

function commandHook(command: string, tag: string): ClaudeCommandHook {
  return {
    type: "command",
    command: `${command} # ${MANAGED_TAG}:${tag}`,
  };
}

function resolveHookCommandPrefix(options: ClaudeCodeHookInstallOptions): string {
  const nodePath = options.nodePath ?? process.env.RECALL_NODE_PATH ?? process.execPath;
  const cliPath = options.cliPath ?? resolveCliPath();
  return `${shellQuote(nodePath)} ${shellQuote(cliPath)}`;
}

function resolveCliPath(): string {
  const fromEnv = process.env.RECALL_CLI_PATH;
  if (fromEnv && existsSync(fromEnv)) {
    return resolve(fromEnv);
  }

  const fromArgv = process.argv[1];
  if (fromArgv && /(?:^|\/)cli\.[cm]?js$/.test(fromArgv) && existsSync(fromArgv)) {
    return resolve(fromArgv);
  }

  const sibling = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
  if (existsSync(sibling)) {
    return sibling;
  }

  const distCli = resolve(process.cwd(), "dist", "cli.js");
  if (existsSync(distCli)) {
    return distCli;
  }

  throw new Error("Unable to resolve Recall CLI path for Claude Code hooks");
}

function readSettingsFile(configPath: string): { raw: string | null; settings: ClaudeSettings } {
  if (!existsSync(configPath)) {
    return { raw: null, settings: {} };
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid Claude Code settings at ${configPath}`);
  }

  return { raw, settings: parsed as ClaudeSettings };
}

function writeSettingsFile(
  configPath: string,
  previousRaw: string | null,
  settings: ClaudeSettings,
) {
  const parentDir = dirname(configPath);
  mkdirSync(parentDir, { recursive: true });

  if (previousRaw != null) {
    const backupPath = `${configPath}.recall.bak.${Date.now()}`;
    writeFileSync(backupPath, previousRaw);
  }

  const tmpPath = `${configPath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmpPath, configPath);
}

function ensureHooksObject(settings: ClaudeSettings): Record<string, ClaudeHookMatcherGroup[]> {
  if (!settings.hooks) {
    settings.hooks = {};
  }
  if (typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    throw new Error("Claude Code hooks config must be an object");
  }
  return settings.hooks;
}

function isManagedGroup(group: ClaudeHookMatcherGroup): boolean {
  return (group.hooks ?? []).some((hook) => typeof hook.command === "string" && hook.command.includes(MANAGED_TAG));
}

function cloneSettings(settings: ClaudeSettings): ClaudeSettings {
  return JSON.parse(JSON.stringify(settings)) as ClaudeSettings;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
