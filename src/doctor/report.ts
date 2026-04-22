import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDbPath, getDbUserVersion, RECALL_DB_USER_VERSION } from "../db/client.js";
import { getEmbeddingModelInfo } from "../embeddings/embeddings.js";
import { getLaunchAgentStatus } from "../daemon/launchd.js";
import { hasCommand, resolveUserHomeDir } from "../agents/utils.js";

export interface AgentDoctorEntry {
  agent: "claude-code" | "codex";
  detected: boolean;
  mcp: boolean;
  hooks: boolean;
  config_path: string;
  hook_path?: string;
  notes: string[];
}

export interface DoctorReport {
  db_path: string;
  db_user_version: number;
  db_target_version: number;
  embeddings: ReturnType<typeof getEmbeddingModelInfo>;
  launchd: {
    installed: boolean;
    loaded: boolean;
    state?: string;
  } | null;
  agents: AgentDoctorEntry[];
}

export function getDoctorReport(): DoctorReport {
  const dbPath = getDbPath();
  const launchd = process.platform === "darwin"
    ? (() => {
        try {
          const status = getLaunchAgentStatus();
          return {
            installed: status.installed,
            loaded: status.loaded,
            state: status.state,
          };
        } catch {
          return null;
        }
      })()
    : null;

  return {
    db_path: dbPath,
    db_user_version: getDbUserVersion(dbPath),
    db_target_version: RECALL_DB_USER_VERSION,
    embeddings: getEmbeddingModelInfo(),
    launchd,
    agents: inspectAgentInstalls(),
  };
}

export function inspectAgentInstalls(homeDir?: string): AgentDoctorEntry[] {
  const home = homeDir ?? resolveUserHomeDir();
  return [
    inspectClaudeCodeInstall(home),
    inspectCodexInstall(home),
  ];
}

function inspectClaudeCodeInstall(home: string): AgentDoctorEntry {
  const configPath = join(home, ".claude", "settings.json");
  const detected = existsSync(configPath) || hasCommand("claude");
  const notes: string[] = [];

  let mcp = false;
  let hooks = false;

  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
      mcp = Boolean(parsed?.mcpServers?.recall);
      const hookGroups = parsed?.hooks ?? {};
      hooks = Object.values(hookGroups).some((groups) =>
        Array.isArray(groups) &&
        groups.some((group: unknown) =>
          isHookGroupManagedBy(group, "recall:managed:claude-code"),
        ),
      );
      if (!mcp) notes.push("MCP server 'recall' not registered in mcpServers");
      if (!hooks) notes.push("No Recall-managed hooks found in settings.json");
    } catch (err) {
      notes.push(`Could not parse ${configPath}: ${(err as Error).message}`);
    }
  } else if (detected) {
    notes.push("Claude CLI detected but settings.json missing");
  }

  return {
    agent: "claude-code",
    detected,
    mcp,
    hooks,
    config_path: configPath,
    notes,
  };
}

function inspectCodexInstall(home: string): AgentDoctorEntry {
  const configPath = join(home, ".codex", "config.toml");
  const hooksPath = join(home, ".codex", "hooks.json");
  const detected = existsSync(configPath) || hasCommand("codex");
  const notes: string[] = [];

  let mcp = false;
  let hooks = false;

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    mcp = /\[mcp_servers\.recall\]/.test(raw);
    const featureFlagSet = /^\s*codex_hooks\s*=\s*true\b/m.test(raw);
    const managedHooksJson =
      existsSync(hooksPath) && readFileSync(hooksPath, "utf-8").includes("recall:managed:codex");
    hooks = featureFlagSet && managedHooksJson;

    if (!mcp) notes.push("MCP block [mcp_servers.recall] not in config.toml");
    if (!featureFlagSet) notes.push("codex_hooks = true missing from [features]");
    if (!managedHooksJson) notes.push("No Recall-managed entries in ~/.codex/hooks.json");
  } else if (detected) {
    notes.push("Codex CLI detected but config.toml missing");
  }

  return {
    agent: "codex",
    detected,
    mcp,
    hooks,
    config_path: configPath,
    hook_path: hooksPath,
    notes,
  };
}

function isHookGroupManagedBy(group: unknown, tag: string): boolean {
  if (!group || typeof group !== "object") return false;
  const hooks = (group as { hooks?: unknown[] }).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (hook) =>
      hook &&
      typeof hook === "object" &&
      typeof (hook as { command?: unknown }).command === "string" &&
      (hook as { command: string }).command.includes(tag),
  );
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    "# Recall Doctor",
    "",
    `DB:        ${report.db_path}`,
    `DB ver:    ${report.db_user_version}/${report.db_target_version}`,
  ];

  if (report.embeddings) {
    lines.push(`Embed:     ${report.embeddings.provider}`);
    lines.push(`Model:     ${report.embeddings.model}`);
    lines.push(`Dims:      index=${report.embeddings.index_dimensions} canonical=${report.embeddings.canonical_dimensions}`);
    lines.push(`Cache:     ${report.embeddings.size_label} @ ${report.embeddings.cache_path}`);
  } else {
    lines.push("Embed:     disabled");
  }

  if (report.launchd) {
    lines.push(`Launchd:   ${report.launchd.installed ? "installed" : "missing"} / ${report.launchd.loaded ? "loaded" : "not loaded"}${report.launchd.state ? ` (${report.launchd.state})` : ""}`);
  }

  lines.push("", "## Agents");
  for (const agent of report.agents) {
    const label = agent.agent.padEnd(12);
    if (!agent.detected) {
      lines.push(`${label} not detected`);
      continue;
    }
    const mcp = agent.mcp ? "ok" : "MISSING";
    const hooks = agent.hooks ? "ok" : "MISSING";
    lines.push(`${label} mcp:${mcp} hooks:${hooks}`);
    for (const note of agent.notes) {
      lines.push(`             - ${note}`);
    }
  }

  const needsFix = report.agents.some((a) => a.detected && (!a.mcp || !a.hooks));
  if (needsFix) {
    lines.push("", "Run `recall doctor --fix` or `recall setup local` to install missing wiring.");
  }

  return lines.join("\n");
}
