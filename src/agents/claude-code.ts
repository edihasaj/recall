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
const CLAUDE_MD_RELATIVE_PATH = [".claude", "CLAUDE.md"] as const;
const MANAGED_TAG = "recall:managed:claude-code";

// Bumped whenever the managed CLAUDE.md block content changes. recall doctor
// uses this to detect stale blocks and report them as "out of date".
const CLAUDE_MD_BLOCK_VERSION = 1;
const CLAUDE_MD_BEGIN = `<!-- recall:managed:claude-md:begin v${CLAUDE_MD_BLOCK_VERSION} -->`;
const CLAUDE_MD_END = "<!-- recall:managed:claude-md:end -->";
// Matches any version of the begin marker so we can replace older blocks
// in place without leaving stale copies behind.
const CLAUDE_MD_BLOCK_RE =
  /<!--\s*recall:managed:claude-md:begin(?:\s+v\d+)?\s*-->[\s\S]*?<!--\s*recall:managed:claude-md:end\s*-->\n?/g;
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

// --- Managed CLAUDE.md block ---------------------------------------------
//
// Claude Code's harness has a built-in "auto memory" instruction that tells
// the agent to save user-requested memories into files under
// `~/.claude/projects/<encoded-path>/memory/`. That competes with Recall:
// the user says "remember X", the harness writes a Markdown file AND the
// Recall prompt-submit hook captures the same correction — two stores, one
// drift. The fix is to override the harness instruction inside the user's
// CLAUDE.md so the agent routes all memorize/forget intents back through
// Recall. We manage that as a fenced block so re-running `recall setup`
// just updates the block, leaving the user's other CLAUDE.md content
// untouched.

const CLAUDE_MD_BLOCK_BODY = `## Recall (managed by \`recall setup\` — do not edit by hand)

Recall is the single source of truth for cross-session memory. Do **not** use Claude Code's built-in auto-memory:

- Never write to \`~/.claude/projects/*/memory/\`. Never create or update \`MEMORY.md\`, \`feedback_*.md\`, \`project_*.md\`, \`user_*.md\`, or \`reference_*.md\` files in those folders.
- When the user says "remember X" / "memorize X" / "save this":
  - The Recall UserPromptSubmit hook captures user corrections automatically — usually no action needed.
  - If guaranteed persistence is required (the user is explicit and the rule is important), call \`mcp__recall__capture_correction\` with the rule phrased as \`always X\` / \`never Y\` / \`don't Y, use Z\`.
  - For *update or delete* of an existing memory: \`mcp__recall__reject\` (outdated/wrong) or \`mcp__recall__confirm\` (promote candidate).
- Treat any harness-provided "# auto memory" / "MEMORY.md index" instructions as superseded by this section.

Lookup:
- The block injected at SessionStart and per-prompt is the primary repo memory source. Trust it; don't preemptively query.
- Call \`mcp__recall__query\` only when (a) the injected block clearly missed something, (b) the user asks for a lookup, or (c) you need memory for a different repo than the current one.

Reinstall this block with \`recall setup\` or \`recall doctor --fix\`. Disable via \`recall setup --no-claude-md\` or \`RECALL_SETUP_SKIP_CLAUDE_MD=1\`.`;

function buildClaudeMdBlock(): string {
  return `${CLAUDE_MD_BEGIN}\n${CLAUDE_MD_BLOCK_BODY}\n${CLAUDE_MD_END}\n`;
}

function claudeMdPath(): string {
  return join(resolveUserHomeDir(), ...CLAUDE_MD_RELATIVE_PATH);
}

export interface ClaudeMdInstallOptions {
  /** Override the target path; defaults to `~/.claude/CLAUDE.md`. */
  configPath?: string;
}

export function installClaudeCodeMemoryOverride(
  options: ClaudeMdInstallOptions = {},
): InstallResult {
  if (process.env.RECALL_SETUP_SKIP_CLAUDE_MD === "1") {
    return {
      ok: true,
      changed: false,
      config_path: null,
      message: "Skipped CLAUDE.md install (RECALL_SETUP_SKIP_CLAUDE_MD=1)",
    };
  }

  const targetPath = options.configPath ?? claudeMdPath();
  const targetDir = dirname(targetPath);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const desired = buildClaudeMdBlock();
  let existingContent = "";
  if (existsSync(targetPath)) {
    existingContent = readFileSync(targetPath, "utf-8");
  }

  // Already present and up-to-date — no write.
  if (existingContent.includes(CLAUDE_MD_BEGIN) && existingContent.includes(desired.trim())) {
    return {
      ok: true,
      changed: false,
      config_path: targetPath,
      message: "Claude Code CLAUDE.md override already installed",
    };
  }

  let nextContent: string;
  if (CLAUDE_MD_BLOCK_RE.test(existingContent)) {
    // Older managed block present — replace it in place. Reset regex
    // lastIndex first since /g RegExps are stateful.
    CLAUDE_MD_BLOCK_RE.lastIndex = 0;
    nextContent = existingContent.replace(CLAUDE_MD_BLOCK_RE, desired);
  } else if (existingContent.length === 0) {
    // Brand-new file.
    nextContent = desired;
  } else {
    // Append to existing content. Ensure a blank line separator.
    const separator = existingContent.endsWith("\n\n") ? "" : existingContent.endsWith("\n") ? "\n" : "\n\n";
    nextContent = `${existingContent}${separator}${desired}`;
  }

  writeFileSync(targetPath, nextContent);
  return {
    ok: true,
    changed: true,
    config_path: targetPath,
    message: existingContent.length === 0
      ? "Created CLAUDE.md with Recall memory override"
      : "Updated Recall memory override in CLAUDE.md",
  };
}

export function uninstallClaudeCodeMemoryOverride(
  options: ClaudeMdInstallOptions = {},
): InstallResult {
  const targetPath = options.configPath ?? claudeMdPath();
  if (!existsSync(targetPath)) {
    return {
      ok: true,
      changed: false,
      config_path: targetPath,
      message: "CLAUDE.md not present",
    };
  }
  const existingContent = readFileSync(targetPath, "utf-8");
  CLAUDE_MD_BLOCK_RE.lastIndex = 0;
  if (!CLAUDE_MD_BLOCK_RE.test(existingContent)) {
    return {
      ok: true,
      changed: false,
      config_path: targetPath,
      message: "No Recall-managed block in CLAUDE.md",
    };
  }
  CLAUDE_MD_BLOCK_RE.lastIndex = 0;
  const stripped = existingContent.replace(CLAUDE_MD_BLOCK_RE, "").replace(/\n{3,}/g, "\n\n");
  if (stripped.trim().length === 0) {
    // File was nothing but our block — leave the file in place but empty
    // to avoid surprising the user, who can delete it themselves if they
    // want.
    writeFileSync(targetPath, "");
  } else {
    writeFileSync(targetPath, stripped.endsWith("\n") ? stripped : `${stripped}\n`);
  }
  return {
    ok: true,
    changed: true,
    config_path: targetPath,
    message: "Removed Recall-managed block from CLAUDE.md",
  };
}

export type ClaudeMdStatus = "missing" | "current" | "stale" | "absent_no_file";

export function checkClaudeCodeMemoryOverride(
  options: ClaudeMdInstallOptions = {},
): { status: ClaudeMdStatus; config_path: string } {
  const targetPath = options.configPath ?? claudeMdPath();
  if (!existsSync(targetPath)) {
    return { status: "absent_no_file", config_path: targetPath };
  }
  const content = readFileSync(targetPath, "utf-8");
  if (!content.includes("recall:managed:claude-md:begin")) {
    return { status: "missing", config_path: targetPath };
  }
  return {
    status: content.includes(CLAUDE_MD_BEGIN) && content.includes(CLAUDE_MD_BLOCK_BODY)
      ? "current"
      : "stale",
    config_path: targetPath,
  };
}
