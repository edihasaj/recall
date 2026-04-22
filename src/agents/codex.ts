import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasCommand, resolveUserHomeDir } from "./utils.js";
import type {
  AgentAdapter,
  HookProfile,
  InstallResult,
} from "./types.js";

const CODEX_CONFIG_RELATIVE_PATH = [".codex", "config.toml"] as const;
const CODEX_HOOKS_RELATIVE_PATH = [".codex", "hooks.json"] as const;
const MANAGED_START = "# recall:managed:codex:start";
const MANAGED_END = "# recall:managed:codex:end";
const MANAGED_FEATURE_FLAG = "# recall:managed:codex:feature";
const MANAGED_HOOK_TAG = "recall:managed:codex";

// Minimum Codex CLI version that supports the hooks.json + [features].codex_hooks
// flow we target in installCodexHooks. Below this we fall back to the legacy
// notify bridge so memory capture still works on older CLIs.
//
// Override at call time by passing options.minCodexHooksVersion, or at runtime
// via RECALL_CODEX_HOOKS_MIN_VERSION for users who have forked/patched their CLI.
const DEFAULT_MIN_CODEX_HOOKS_VERSION = "0.115.0";

export interface CodexCapability {
  hooks_json: boolean;
  detected_version: string | null;
  required_version: string;
  reason?: string;
}

export interface CodexHookInstallOptions {
  configPath?: string;
  hooksPath?: string;
  cliPath?: string;
  nodePath?: string;
  profile?: HookProfile;
  /** Override the minimum Codex CLI version that is eligible for hooks.json install. */
  minCodexHooksVersion?: string;
  /** Skip the version probe and install hooks.json regardless of detected version. */
  forceHooks?: boolean;
  /** Skip hooks.json entirely and use the legacy notify bridge. */
  forceNotifyBridge?: boolean;
}

const configPath = () => join(resolveUserHomeDir(), ...CODEX_CONFIG_RELATIVE_PATH);
const hooksJsonPath = () => join(resolveUserHomeDir(), ...CODEX_HOOKS_RELATIVE_PATH);

export const codexAdapter: AgentAdapter = {
  name: "codex",
  configPath,
  detect() {
    return existsSync(configPath()) || hasCommand("codex") ? "installed" : "not-installed";
  },
  capabilities() {
    return {
      supports: ["prompt_submitted", "tool_invoked", "session_ended"],
      supports_hook_install: true,
      supports_mcp_fallback: true,
    };
  },
  installHooks(profile: HookProfile): InstallResult {
    return installCodexHooks({ profile });
  },
  uninstallHooks(): InstallResult {
    return uninstallCodexHooks();
  },
  envMapping: {
    prompt_submitted: {
      prompt: "text",
      session_id: "session_id",
      cwd: "repo_path",
    },
    tool_invoked: {
      tool_name: "name",
      cwd: "repo_path",
      tool_input: "input_summary",
    },
    session_ended: {
      session_id: "session_id",
      cwd: "repo_path",
      reason: "event",
    },
  },
  writeMcpFallback(): InstallResult {
    throw new Error("Codex MCP fallback wiring not implemented yet.");
  },
};

export function installCodexNotifyBridge(
  options: CodexHookInstallOptions = {},
): InstallResult {
  const targetPath = options.configPath ?? configPath();
  const existing = existsSync(targetPath)
    ? readFileSync(targetPath, "utf-8")
    : "";
  const stripped = stripManagedBlock(existing);

  if (hasUnmanagedNotify(stripped)) {
    return {
      ok: false,
      changed: false,
      config_path: targetPath,
      message: "Codex notify is already configured outside Recall-managed block",
    };
  }

  const managedBlock = buildManagedNotifyBlock(options);
  const next = appendManagedBlock(stripped, managedBlock);

  if (next === existing) {
    return {
      ok: true,
      changed: false,
      config_path: targetPath,
      message: "Codex notify bridge already installed",
    };
  }

  writeConfigFile(targetPath, existing || null, next);
  return {
    ok: true,
    changed: true,
    config_path: targetPath,
    message: "Installed Codex Recall notify bridge",
  };
}

export function uninstallCodexNotifyBridge(
  options: Pick<CodexHookInstallOptions, "configPath"> = {},
): InstallResult {
  const targetPath = options.configPath ?? configPath();
  if (!existsSync(targetPath)) {
    return {
      ok: true,
      changed: false,
      config_path: targetPath,
      message: "Codex config.toml not found",
    };
  }

  const existing = readFileSync(targetPath, "utf-8");
  const next = stripManagedBlock(existing);
  if (next === existing) {
    return {
      ok: true,
      changed: false,
      config_path: targetPath,
      message: "No Recall-managed Codex notify bridge found",
    };
  }

  writeConfigFile(targetPath, existing, next);
  return {
    ok: true,
    changed: true,
    config_path: targetPath,
    message: "Removed Codex Recall notify bridge",
  };
}

interface CodexHooksFile {
  hooks?: Record<string, CodexHookMatcherGroup[]>;
  [key: string]: unknown;
}

interface CodexHookMatcherGroup {
  matcher?: string;
  hooks?: CodexCommandHook[];
  [key: string]: unknown;
}

interface CodexCommandHook {
  type: "command";
  command: string;
  [key: string]: unknown;
}

export function detectCodexCapability(
  options: Pick<CodexHookInstallOptions, "minCodexHooksVersion"> = {},
): CodexCapability {
  const required = options.minCodexHooksVersion
    ?? process.env.RECALL_CODEX_HOOKS_MIN_VERSION
    ?? DEFAULT_MIN_CODEX_HOOKS_VERSION;
  const detected = probeCodexVersion();
  if (!detected) {
    return {
      hooks_json: false,
      detected_version: null,
      required_version: required,
      reason: "codex CLI not found on PATH — cannot verify hook support",
    };
  }
  if (compareSemver(detected, required) < 0) {
    return {
      hooks_json: false,
      detected_version: detected,
      required_version: required,
      reason: `codex ${detected} < ${required} (hooks.json unsupported)`,
    };
  }
  return {
    hooks_json: true,
    detected_version: detected,
    required_version: required,
  };
}

export function installCodexHooks(
  options: CodexHookInstallOptions = {},
): InstallResult {
  const targetConfig = options.configPath ?? configPath();
  const targetHooks = options.hooksPath ?? hooksJsonPath();

  const capability = options.forceNotifyBridge
    ? { hooks_json: false, detected_version: null, required_version: "n/a", reason: "forced notify bridge" }
    : options.forceHooks
      ? { hooks_json: true, detected_version: null, required_version: "n/a" }
      : detectCodexCapability(options);

  if (!capability.hooks_json) {
    const bridge = installCodexNotifyBridge(options);
    const reason = capability.reason ?? "codex hooks unsupported";
    return {
      ok: bridge.ok,
      changed: bridge.changed,
      config_path: bridge.config_path,
      message: `${bridge.message} (fell back to notify bridge: ${reason})`,
    };
  }

  // Migration: legacy notify bridge would double-fire on every prompt. Remove first.
  uninstallCodexNotifyBridge({ configPath: targetConfig });

  const flagResult = ensureCodexHooksFeatureFlag(targetConfig);
  const hooksResult = writeCodexHooksJson(targetHooks, options);

  const changed = flagResult.changed || hooksResult.changed;
  const ok = flagResult.ok && hooksResult.ok;
  const versionNote = capability.detected_version
    ? ` (codex ${capability.detected_version})`
    : "";
  const messages = [flagResult.message, hooksResult.message].filter(Boolean).join("; ");

  return {
    ok,
    changed,
    config_path: targetHooks,
    message: (messages || (changed ? "Installed Codex hooks.json" : "Codex hooks already installed")) + versionNote,
  };
}

function probeCodexVersion(): string | null {
  if (!hasCommand("codex")) return null;
  try {
    const raw = execFileSync("codex", ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    return extractSemverFromVersionString(raw);
  } catch {
    return null;
  }
}

export function extractSemverFromVersionString(raw: string): string | null {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9.-]+)?/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

export function uninstallCodexHooks(
  options: Pick<CodexHookInstallOptions, "configPath" | "hooksPath"> = {},
): InstallResult {
  const targetConfig = options.configPath ?? configPath();
  const targetHooks = options.hooksPath ?? hooksJsonPath();

  const flagResult = removeCodexHooksFeatureFlag(targetConfig);
  const hooksResult = removeCodexHooksJson(targetHooks);
  const legacyResult = uninstallCodexNotifyBridge({ configPath: targetConfig });

  const changed = flagResult.changed || hooksResult.changed || legacyResult.changed;
  const ok = flagResult.ok && hooksResult.ok && legacyResult.ok;

  return {
    ok,
    changed,
    config_path: targetHooks,
    message: changed ? "Removed Codex Recall hooks" : "No Recall-managed Codex hooks found",
  };
}

function writeCodexHooksJson(
  targetPath: string,
  options: CodexHookInstallOptions,
): InstallResult {
  const existing = readCodexHooksJson(targetPath);
  const next = cloneCodexHooks(existing.parsed);
  const hooks = ensureCodexHooksObject(next);
  const managed = buildCodexManagedGroups(options);

  let changed = false;
  for (const [eventName, groups] of Object.entries(managed)) {
    const current = hooks[eventName] ?? [];
    const preserved = current.filter((group) => !isCodexManagedGroup(group));
    const merged = [...preserved, ...groups];
    if (JSON.stringify(current) !== JSON.stringify(merged)) {
      hooks[eventName] = merged;
      changed = true;
    }
  }

  if (!changed) {
    return {
      ok: true,
      changed: false,
      config_path: targetPath,
      message: "",
    };
  }

  writeJsonFile(targetPath, existing.raw, next);
  return {
    ok: true,
    changed: true,
    config_path: targetPath,
    message: "wrote hooks.json",
  };
}

function removeCodexHooksJson(targetPath: string): InstallResult {
  if (!existsSync(targetPath)) {
    return { ok: true, changed: false, config_path: targetPath, message: "" };
  }

  const existing = readCodexHooksJson(targetPath);
  const next = cloneCodexHooks(existing.parsed);
  const hooks = next.hooks;
  if (!hooks || typeof hooks !== "object") {
    return { ok: true, changed: false, config_path: targetPath, message: "" };
  }

  let changed = false;
  for (const eventName of Object.keys(hooks)) {
    const current = hooks[eventName] ?? [];
    const preserved = current.filter((group) => !isCodexManagedGroup(group));
    if (preserved.length !== current.length) {
      changed = true;
      if (preserved.length > 0) {
        hooks[eventName] = preserved;
      } else {
        delete hooks[eventName];
      }
    }
  }

  if (Object.keys(hooks).length === 0) delete next.hooks;

  if (!changed) {
    return { ok: true, changed: false, config_path: targetPath, message: "" };
  }

  writeJsonFile(targetPath, existing.raw, next);
  return { ok: true, changed: true, config_path: targetPath, message: "cleaned hooks.json" };
}

function buildCodexManagedGroups(
  options: CodexHookInstallOptions,
): Record<string, CodexHookMatcherGroup[]> {
  const installedEvents = new Set(options.profile ?? []);
  const commandPrefix = resolveHookCommandPrefix(options);
  const groups: Record<string, CodexHookMatcherGroup[]> = {};

  groups.SessionStart = [
    {
      matcher: "startup|resume",
      hooks: [commandHook(`${commandPrefix} hook session-start --agent codex --codex-stdin`, "session-start")],
    },
  ];

  if (installedEvents.size === 0 || installedEvents.has("prompt_submitted")) {
    groups.UserPromptSubmit = [
      {
        hooks: [commandHook(`${commandPrefix} hook prompt --agent codex --codex-stdin`, "prompt")],
      },
    ];
  }

  if (installedEvents.size === 0 || installedEvents.has("tool_invoked")) {
    groups.PostToolUse = [
      {
        matcher: "Bash",
        hooks: [commandHook(`${commandPrefix} hook tool --agent codex --codex-stdin`, "tool")],
      },
    ];
  }

  return groups;
}

function commandHook(command: string, tag: string): CodexCommandHook {
  return {
    type: "command",
    command: `${command} # ${MANAGED_HOOK_TAG}:${tag}`,
  };
}

function resolveHookCommandPrefix(options: CodexHookInstallOptions): string {
  const nodePath = options.nodePath ?? process.env.RECALL_NODE_PATH ?? process.execPath;
  const cliPath = options.cliPath ?? resolveCliPath();
  return `${shellQuote(nodePath)} ${shellQuote(cliPath)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readCodexHooksJson(targetPath: string): { raw: string | null; parsed: CodexHooksFile } {
  if (!existsSync(targetPath)) return { raw: null, parsed: {} };
  const raw = readFileSync(targetPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid Codex hooks.json at ${targetPath}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Codex hooks.json must be an object at ${targetPath}`);
  }
  return { raw, parsed: parsed as CodexHooksFile };
}

function writeJsonFile(targetPath: string, previousRaw: string | null, value: unknown) {
  const parentDir = dirname(targetPath);
  mkdirSync(parentDir, { recursive: true });
  if (previousRaw != null) {
    writeFileSync(`${targetPath}.recall.bak.${Date.now()}`, previousRaw);
  }
  const tmpPath = `${targetPath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmpPath, targetPath);
}

function ensureCodexHooksObject(file: CodexHooksFile): Record<string, CodexHookMatcherGroup[]> {
  if (!file.hooks) file.hooks = {};
  if (typeof file.hooks !== "object" || Array.isArray(file.hooks)) {
    throw new Error("Codex hooks.json hooks must be an object");
  }
  return file.hooks;
}

function isCodexManagedGroup(group: CodexHookMatcherGroup): boolean {
  return (group.hooks ?? []).some(
    (hook) => typeof hook.command === "string" && hook.command.includes(MANAGED_HOOK_TAG),
  );
}

function cloneCodexHooks(file: CodexHooksFile): CodexHooksFile {
  return JSON.parse(JSON.stringify(file)) as CodexHooksFile;
}

function ensureCodexHooksFeatureFlag(targetConfigPath: string): InstallResult {
  const existing = existsSync(targetConfigPath) ? readFileSync(targetConfigPath, "utf-8") : "";

  if (/^\s*codex_hooks\s*=\s*true\b/m.test(existing)) {
    return { ok: true, changed: false, config_path: targetConfigPath, message: "" };
  }

  const featureHeader = /^\[features\]\s*$/m;
  let next: string;
  if (featureHeader.test(existing)) {
    next = existing.replace(
      featureHeader,
      `[features]\ncodex_hooks = true ${MANAGED_FEATURE_FLAG}`,
    );
  } else {
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    next = `${existing}${separator}\n[features]\ncodex_hooks = true ${MANAGED_FEATURE_FLAG}\n`;
  }

  writeConfigFile(targetConfigPath, existing || null, next);
  return { ok: true, changed: true, config_path: targetConfigPath, message: "enabled codex_hooks feature flag" };
}

function removeCodexHooksFeatureFlag(targetConfigPath: string): InstallResult {
  if (!existsSync(targetConfigPath)) {
    return { ok: true, changed: false, config_path: targetConfigPath, message: "" };
  }
  const existing = readFileSync(targetConfigPath, "utf-8");
  const managedLine = new RegExp(
    `^\\s*codex_hooks\\s*=\\s*true\\s*${escapeRegExp(MANAGED_FEATURE_FLAG)}\\s*$\\n?`,
    "m",
  );
  if (!managedLine.test(existing)) {
    return { ok: true, changed: false, config_path: targetConfigPath, message: "" };
  }
  const next = existing.replace(managedLine, "");
  writeConfigFile(targetConfigPath, existing, next);
  return { ok: true, changed: true, config_path: targetConfigPath, message: "removed codex_hooks flag" };
}

function buildManagedNotifyBlock(options: CodexHookInstallOptions): string {
  const command = [
    options.nodePath ?? process.env.RECALL_NODE_PATH ?? process.execPath,
    options.cliPath ?? resolveCliPath(),
    "hook",
    "codex-notify",
  ];
  return `${MANAGED_START}
notify = ${renderTomlStringArray(command)}
${MANAGED_END}
`;
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

  throw new Error("Unable to resolve Recall CLI path for Codex notify bridge");
}

function stripManagedBlock(content: string): string {
  if (!content.includes(MANAGED_START)) {
    return content;
  }

  return content
    .replace(new RegExp(`${escapeRegExp(MANAGED_START)}[\\s\\S]*?${escapeRegExp(MANAGED_END)}\\n?`, "g"), "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
}

function appendManagedBlock(content: string, block: string): string {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return block;
  }
  return `${trimmed}\n\n${block}`;
}

function hasUnmanagedNotify(content: string): boolean {
  return /^\s*notify\s*=.*$/m.test(content);
}

function renderTomlStringArray(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function writeConfigFile(
  configPathValue: string,
  previousRaw: string | null,
  nextRaw: string,
) {
  const parentDir = dirname(configPathValue);
  mkdirSync(parentDir, { recursive: true });

  if (previousRaw != null) {
    writeFileSync(`${configPathValue}.recall.bak.${Date.now()}`, previousRaw);
  }

  const tmpPath = `${configPathValue}.tmp.${process.pid}`;
  writeFileSync(tmpPath, normalizeTrailingNewline(nextRaw));
  renameSync(tmpPath, configPathValue);
}

function normalizeTrailingNewline(content: string): string {
  return content.trim().length === 0 ? "" : `${content.trimEnd()}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
