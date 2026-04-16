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

const CODEX_CONFIG_RELATIVE_PATH = [".codex", "config.toml"] as const;
const MANAGED_START = "# recall:managed:codex:start";
const MANAGED_END = "# recall:managed:codex:end";

export interface CodexHookInstallOptions {
  configPath?: string;
  cliPath?: string;
  nodePath?: string;
  profile?: HookProfile;
}

const configPath = () => join(resolveUserHomeDir(), ...CODEX_CONFIG_RELATIVE_PATH);

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

export function installCodexHooks(
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

export function uninstallCodexHooks(
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
