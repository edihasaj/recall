import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getDbPath, getDbUserVersion, RECALL_DB_USER_VERSION } from "../db/client.js";
import { getEmbeddingModelInfo } from "../embeddings/embeddings.js";
import { getLaunchAgentStatus } from "../daemon/launchd.js";
import { getSystemdStatus } from "../daemon/systemd.js";
import { hasCommand, resolveUserHomeDir } from "../agents/utils.js";
import { checkClaudeCodeMemoryOverride } from "../agents/claude-code.js";

export interface AgentDoctorEntry {
  agent: "claude-code" | "codex";
  detected: boolean;
  mcp: boolean;
  hooks: boolean;
  legacy_notify_bridge?: boolean;
  config_path: string;
  hook_path?: string;
  /** Only set for Claude Code — managed CLAUDE.md memory-override block status. */
  claude_md?: "current" | "stale" | "missing" | "absent_no_file";
  claude_md_path?: string;
  notes: string[];
}

export interface UpgradeSignal {
  available: boolean;
  reasons: string[];
}

export interface CleanupHealth {
  last_run_id: string | null;
  last_run_at: string | null;
  last_run_actions: Record<string, number>;
  total_runs: number;
  pending_candidate_corrections: number;
  followed_rate_resolved: number | null;
  resolved_injections: number;
}

export interface DispatcherHealth {
  providers_configured: string[];
  pending_tasks: Record<string, number>;
  last_dispatch_at: string | null;
  last_dispatch_outcome: "ok" | "error" | null;
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
  systemd: {
    installed: boolean;
    loaded: boolean;
    state?: string;
  } | null;
  agents: AgentDoctorEntry[];
  upgrade: UpgradeSignal;
  cleanup: CleanupHealth | null;
  dispatcher: DispatcherHealth | null;
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

  const systemd = process.platform === "linux"
    ? (() => {
        try {
          const status = getSystemdStatus();
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

  const agents = inspectAgentInstalls();
  return {
    db_path: dbPath,
    db_user_version: getDbUserVersion(dbPath),
    db_target_version: RECALL_DB_USER_VERSION,
    embeddings: getEmbeddingModelInfo(),
    launchd,
    systemd,
    agents,
    upgrade: computeUpgradeSignal(agents),
    cleanup: readCleanupHealth(dbPath),
    dispatcher: readDispatcherHealth(dbPath),
  };
}

function readDispatcherHealth(dbPath: string): DispatcherHealth | null {
  if (!existsSync(dbPath)) return null;
  let sqlite: Database.Database | null = null;
  try {
    sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
    const tables = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('memory_maintenance_tasks','llm_usage')",
    ).all() as Array<{ name: string }>;
    const names = new Set(tables.map((t) => t.name));

    let providers: string[] = [];
    try {
      // Probe synchronously without importing the keychain module (which would
      // pull node-keychain into the read-only doctor path).
      const { hasProviderConfigured } = require("../credentials/keychain.js");
      providers = ["anthropic", "azure-openai", "openai"].filter((p) =>
        hasProviderConfigured(p),
      );
    } catch {
      providers = [];
    }

    const pending: Record<string, number> = {};
    if (names.has("memory_maintenance_tasks")) {
      const rows = sqlite.prepare(
        "SELECT kind, COUNT(*) AS n FROM memory_maintenance_tasks WHERE status='pending' GROUP BY kind",
      ).all() as Array<{ kind: string; n: number }>;
      for (const r of rows) pending[r.kind] = r.n;
    }

    let lastAt: string | null = null;
    let lastOk: "ok" | "error" | null = null;
    if (names.has("llm_usage")) {
      const row = sqlite.prepare(
        "SELECT created_at, ok FROM llm_usage ORDER BY created_at DESC LIMIT 1",
      ).get() as { created_at: string; ok: number } | undefined;
      if (row) {
        lastAt = row.created_at;
        lastOk = row.ok ? "ok" : "error";
      }
    }

    return {
      providers_configured: providers,
      pending_tasks: pending,
      last_dispatch_at: lastAt,
      last_dispatch_outcome: lastOk,
    };
  } catch {
    return null;
  } finally {
    sqlite?.close();
  }
}

function readCleanupHealth(dbPath: string): CleanupHealth | null {
  if (!existsSync(dbPath)) return null;
  let sqlite: Database.Database | null = null;
  try {
    sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });

    const tables = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('maintenance_cleanup_log','memories','memory_injections')",
    ).all() as Array<{ name: string }>;
    const names = new Set(tables.map((t) => t.name));
    if (!names.has("maintenance_cleanup_log")) return null;

    const totals = sqlite.prepare(
      "SELECT COUNT(DISTINCT run_id) AS runs, MAX(created_at) AS last_at FROM maintenance_cleanup_log",
    ).get() as { runs: number; last_at: string | null };

    let lastRunId: string | null = null;
    const actions: Record<string, number> = {};
    if (totals.last_at) {
      const lastRow = sqlite.prepare(
        "SELECT run_id FROM maintenance_cleanup_log WHERE created_at = ? LIMIT 1",
      ).get(totals.last_at) as { run_id: string } | undefined;
      lastRunId = lastRow?.run_id ?? null;
      if (lastRunId) {
        const rows = sqlite.prepare(
          "SELECT action, COUNT(*) as c FROM maintenance_cleanup_log WHERE run_id = ? GROUP BY action",
        ).all(lastRunId) as Array<{ action: string; c: number }>;
        for (const r of rows) actions[r.action] = r.c;
      }
    }

    let pending = 0;
    if (names.has("memories")) {
      const row = sqlite.prepare(
        "SELECT COUNT(*) AS n FROM memories WHERE status='candidate' AND source='user_correction'",
      ).get() as { n: number };
      pending = row.n;
    }

    let followedRate: number | null = null;
    let resolvedInjections = 0;
    if (names.has("memory_injections")) {
      const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
      const rows = sqlite.prepare(
        "SELECT outcome, COUNT(*) as c FROM memory_injections WHERE injected_at >= ? GROUP BY outcome",
      ).all(since) as Array<{ outcome: string | null; c: number }>;
      let followed = 0;
      for (const r of rows) {
        if (!r.outcome) continue;
        resolvedInjections += r.c;
        if (r.outcome === "followed") followed += r.c;
      }
      followedRate = resolvedInjections > 0 ? followed / resolvedInjections : null;
    }

    return {
      last_run_id: lastRunId,
      last_run_at: totals.last_at,
      last_run_actions: actions,
      total_runs: totals.runs,
      pending_candidate_corrections: pending,
      followed_rate_resolved: followedRate,
      resolved_injections: resolvedInjections,
    };
  } catch {
    return null;
  } finally {
    sqlite?.close();
  }
}

function computeUpgradeSignal(agents: AgentDoctorEntry[]): UpgradeSignal {
  const reasons: string[] = [];
  for (const agent of agents) {
    if (!agent.detected) continue;
    if (agent.legacy_notify_bridge) {
      reasons.push(
        `${agent.agent}: legacy notify bridge detected — upgrade to hooks.json for per-turn memory injection`,
      );
      continue;
    }
    if (agent.mcp && !agent.hooks) {
      reasons.push(
        `${agent.agent}: MCP configured but lifecycle hooks missing — memory injection depends on the model calling query`,
      );
    }
  }
  return { available: reasons.length > 0, reasons };
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

  // CLAUDE.md memory-override block. Status mirrors the install: current =
  // installed and matches shipped content, stale = older block present (needs
  // `recall doctor --fix`), missing = file exists but no managed block,
  // absent_no_file = no CLAUDE.md at the expected path.
  // Honor the `home` parameter so tests can scope to a temp HOME — otherwise
  // the check always hits the real ~/.claude/CLAUDE.md.
  const claudeMd = checkClaudeCodeMemoryOverride({
    configPath: join(home, ".claude", "CLAUDE.md"),
  });
  if (claudeMd.status === "stale") {
    notes.push("CLAUDE.md memory-override block is out of date — run `recall doctor --fix`");
  } else if (claudeMd.status === "missing") {
    notes.push("CLAUDE.md exists but has no Recall memory-override block — Claude Code's built-in auto-memory may race Recall");
  } else if (claudeMd.status === "absent_no_file" && detected) {
    notes.push("No CLAUDE.md at ~/.claude/CLAUDE.md — run `recall doctor --fix` to install the memory-override block");
  }

  return {
    agent: "claude-code",
    detected,
    mcp,
    hooks,
    config_path: configPath,
    claude_md: claudeMd.status,
    claude_md_path: claudeMd.config_path,
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
  let legacy_notify_bridge = false;

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    mcp = /\[mcp_servers\.recall\]/.test(raw);
    // Codex >= 0.137 renamed the flag to `hooks` and rewrites config.toml with
    // the canonical name; accept either spelling.
    const featureFlagSet = /^\s*(?:codex_)?hooks\s*=\s*true\b/m.test(raw);
    const managedHooksJson =
      existsSync(hooksPath) && readFileSync(hooksPath, "utf-8").includes("recall:managed:codex");
    hooks = featureFlagSet && managedHooksJson;
    legacy_notify_bridge =
      raw.includes("# recall:managed:codex:start") &&
      raw.includes("codex-notify");

    if (!mcp) notes.push("MCP block [mcp_servers.recall] not in config.toml");
    if (legacy_notify_bridge) {
      notes.push(
        "Legacy notify bridge present — install the new hooks.json path to enable per-turn memory injection",
      );
    }
    if (!featureFlagSet) notes.push("hooks = true (or legacy codex_hooks = true) missing from [features]");
    if (!managedHooksJson) notes.push("No Recall-managed entries in ~/.codex/hooks.json");
  } else if (detected) {
    notes.push("Codex CLI detected but config.toml missing");
  }

  return {
    agent: "codex",
    detected,
    mcp,
    hooks,
    legacy_notify_bridge,
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
  if (report.systemd) {
    lines.push(`Systemd:   ${report.systemd.installed ? "installed" : "missing"} / ${report.systemd.loaded ? "loaded" : "not loaded"}${report.systemd.state ? ` (${report.systemd.state})` : ""}`);
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
    const legacy = agent.legacy_notify_bridge ? " (legacy notify bridge)" : "";
    const claudeMd = agent.claude_md
      ? ` claude.md:${agent.claude_md === "current" ? "ok" : agent.claude_md.toUpperCase()}`
      : "";
    lines.push(`${label} mcp:${mcp} hooks:${hooks}${claudeMd}${legacy}`);
    for (const note of agent.notes) {
      lines.push(`             - ${note}`);
    }
  }

  if (report.cleanup) {
    lines.push("", "## Cleanup");
    if (report.cleanup.last_run_at) {
      const actions = Object.entries(report.cleanup.last_run_actions)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      lines.push(`Last run:  ${report.cleanup.last_run_id?.slice(0, 8)} at ${report.cleanup.last_run_at.slice(0, 19)}`);
      lines.push(`Actions:   ${actions || "(none)"}`);
    } else {
      lines.push("Last run:  never");
    }
    lines.push(`Total runs: ${report.cleanup.total_runs}`);
    lines.push(`Pending correction candidates: ${report.cleanup.pending_candidate_corrections}`);
    if (report.cleanup.followed_rate_resolved != null) {
      const pct = (report.cleanup.followed_rate_resolved * 100).toFixed(1);
      lines.push(`Followed rate (last 14d, of ${report.cleanup.resolved_injections} resolved): ${pct}%`);
    } else {
      lines.push(`Followed rate (last 14d): n/a (no resolved injections)`);
    }
  }

  if (report.dispatcher) {
    lines.push("", "## Dispatcher (LLM refinement)");
    const provs = report.dispatcher.providers_configured;
    lines.push(`Providers: ${provs.length === 0 ? "none configured (LLM tier dormant)" : provs.join(", ")}`);
    const pendingEntries = Object.entries(report.dispatcher.pending_tasks);
    if (pendingEntries.length === 0) {
      lines.push("Pending tasks: 0");
    } else {
      const total = pendingEntries.reduce((s, [, n]) => s + n, 0);
      lines.push(`Pending tasks: ${total} (${pendingEntries.map(([k, n]) => `${k}=${n}`).join(", ")})`);
    }
    if (report.dispatcher.last_dispatch_at) {
      lines.push(`Last dispatch: ${report.dispatcher.last_dispatch_at.slice(0, 19)} (${report.dispatcher.last_dispatch_outcome ?? "unknown"})`);
    } else {
      lines.push("Last dispatch: never");
    }
    if (provs.length === 0 && pendingEntries.length > 0) {
      lines.push("Tasks are queued but no provider is configured. Run `recall maintenance dispatch --preview` to inspect prompts, or `recall maintenance credentials set <provider> <key>` to enable.");
    }
  }

  if (report.upgrade.available) {
    lines.push("", "## Upgrade available");
    for (const reason of report.upgrade.reasons) {
      lines.push(`- ${reason}`);
    }
    lines.push("Run `recall doctor --fix` or `recall setup --yes` to apply.");
  }

  return lines.join("\n");
}
