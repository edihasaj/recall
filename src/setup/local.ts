import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { installClaudeCodeHooks, uninstallClaudeCodeHooks } from "../agents/claude-code.js";
import { installCodexHooks, uninstallCodexHooks } from "../agents/codex.js";
import type { AgentName } from "../agents/types.js";
import { hasCommand, resolveUserHomeDir } from "../agents/utils.js";

export interface LocalSetupOptions {
  appPath?: string;
  codex?: boolean;
  claude?: boolean;
}

export interface LocalSetupResult {
  appPath: string;
  runtimeNodePath: string;
  runtimeCliPath: string;
  runtimeMcpPath: string;
  codex: SetupStepResult;
  claude: SetupStepResult;
  codex_hooks: SetupStepResult;
  claude_hooks: SetupStepResult;
}

export interface SetupStepResult {
  enabled: boolean;
  ok: boolean;
  message: string;
}

export type SetupScope = "global" | "project";

export interface AgentSetupResult {
  agent: AgentName;
  detected: boolean;
  mcp: SetupStepResult;
  hooks: SetupStepResult;
  hook_config_path: string | null;
}

export interface RecallSetupOptions {
  agent?: AgentName[];
  appPath?: string;
  cwd?: string;
  dryRun?: boolean;
  hooksOnly?: boolean;
  mcpOnly?: boolean;
  scope?: SetupScope;
  uninstallHooks?: boolean;
  runner?: CommandRunner;
}

export interface RecallSetupResult {
  appPath: string;
  runtimeNodePath: string;
  runtimeCliPath: string;
  runtimeMcpPath: string;
  scope: SetupScope;
  dry_run: boolean;
  hooks_only: boolean;
  mcp_only: boolean;
  uninstall_hooks: boolean;
  agents: AgentSetupResult[];
}

type CommandRunner = (command: string, args: string[]) => void;

export function resolveRuntimePaths(appPath?: string) {
  const resolvedAppPath = appPath ?? "/Applications/Recall.app";
  const runtimeRoot = join(resolvedAppPath, "Contents", "Resources", "Runtime");
  return {
    appPath: resolvedAppPath,
    runtimeNodePath: join(runtimeRoot, "bin", "node"),
    runtimeCliPath: join(runtimeRoot, "dist", "cli.js"),
    runtimeMcpPath: join(runtimeRoot, "dist", "mcp.js"),
  };
}

export function runLocalSetup(opts: LocalSetupOptions = {}): LocalSetupResult {
  const targetCodex = opts.codex ?? true;
  const targetClaude = opts.claude ?? true;
  const result = runRecallSetup({
    appPath: opts.appPath,
    agent: [
      ...(targetCodex ? ["codex" as const] : []),
      ...(targetClaude ? ["claude-code" as const] : []),
    ],
    hooksOnly: false,
    mcpOnly: false,
    scope: "global",
  });

  const codex = result.agents.find((agent) => agent.agent === "codex");
  const claude = result.agents.find((agent) => agent.agent === "claude-code");

  return {
    appPath: result.appPath,
    runtimeNodePath: result.runtimeNodePath,
    runtimeCliPath: result.runtimeCliPath,
    runtimeMcpPath: result.runtimeMcpPath,
    codex: codex?.mcp ?? skipped("skipped"),
    claude: claude?.mcp ?? skipped("skipped"),
    codex_hooks: codex?.hooks ?? skipped("skipped"),
    claude_hooks: claude?.hooks ?? skipped("skipped"),
  };
}

export function runRecallSetup(opts: RecallSetupOptions = {}): RecallSetupResult {
  const scope = opts.scope ?? "global";
  const dryRun = opts.dryRun ?? false;
  const hooksOnly = opts.hooksOnly ?? false;
  const mcpOnly = opts.mcpOnly ?? false;
  const uninstallHooks = opts.uninstallHooks ?? false;
  const runner = opts.runner ?? defaultRunner;
  const paths = resolveRuntimePaths(opts.appPath);

  if (!existsSync(paths.appPath)) {
    throw new Error(`Recall.app not found at ${paths.appPath}`);
  }
  if (!existsSync(paths.runtimeNodePath)) {
    throw new Error(`Bundled node runtime not found at ${paths.runtimeNodePath}`);
  }
  if (!existsSync(paths.runtimeCliPath)) {
    throw new Error(`Bundled CLI entry not found at ${paths.runtimeCliPath}`);
  }
  if (!existsSync(paths.runtimeMcpPath)) {
    throw new Error(`Bundled MCP entry not found at ${paths.runtimeMcpPath}`);
  }

  const targetAgents = resolveTargetAgents(opts.agent);
  const cwd = resolve(opts.cwd ?? process.cwd());
  const agents = targetAgents.map((agent) =>
    setupAgent(agent, {
      cwd,
      dryRun,
      hooksOnly,
      mcpOnly,
      paths,
      runner,
      scope,
      uninstallHooks,
    }),
  );

  return {
    ...paths,
    scope,
    dry_run: dryRun,
    hooks_only: hooksOnly,
    mcp_only: mcpOnly,
    uninstall_hooks: uninstallHooks,
    agents,
  };
}

function setupAgent(
  agent: AgentName,
  options: {
    cwd: string;
    dryRun: boolean;
    hooksOnly: boolean;
    mcpOnly: boolean;
    paths: ReturnType<typeof resolveRuntimePaths>;
    runner: CommandRunner;
    scope: SetupScope;
    uninstallHooks: boolean;
  },
): AgentSetupResult {
  const detected = detectAgent(agent);
  const hookConfigPath = resolveHookConfigPath(agent, options.scope, options.cwd);

  const mcp = options.hooksOnly
    ? skipped("hooks-only")
    : configureMcp(agent, options);
  const hooks = options.mcpOnly
    ? skipped("mcp-only")
    : configureHooks(agent, {
        configPath: hookConfigPath,
        dryRun: options.dryRun,
        paths: options.paths,
        uninstallHooks: options.uninstallHooks,
      });

  return {
    agent,
    detected,
    mcp,
    hooks,
    hook_config_path: options.mcpOnly ? null : hookConfigPath,
  };
}

function configureMcp(
  agent: AgentName,
  options: {
    dryRun: boolean;
    paths: ReturnType<typeof resolveRuntimePaths>;
    runner: CommandRunner;
    scope: SetupScope;
  },
): SetupStepResult {
  if (agent === "codex") {
    if (!hasCommand("codex")) return skipped("codex not found on PATH");
    if (options.scope === "project") {
      return skipped("project-scoped Codex MCP not supported by Codex CLI");
    }
    if (options.dryRun) {
      return ok("would configure global Codex MCP server");
    }
    tryRun(options.runner, "codex", ["mcp", "remove", "recall"]);
    options.runner("codex", ["mcp", "add", "recall", "--", options.paths.runtimeNodePath, options.paths.runtimeMcpPath]);
    return ok("configured global Codex MCP server");
  }

  if (!hasCommand("claude")) return skipped("claude not found on PATH");
  const claudeScope = options.scope === "project" ? "project" : "user";
  if (options.dryRun) {
    return ok(`would configure ${claudeScope} Claude MCP server`);
  }
  tryRun(options.runner, "claude", ["mcp", "remove", "recall", "-s", claudeScope]);
  options.runner("claude", ["mcp", "add", "-s", claudeScope, "recall", options.paths.runtimeNodePath, options.paths.runtimeMcpPath]);
  return ok(`configured ${claudeScope} Claude MCP server`);
}

function configureHooks(
  agent: AgentName,
  options: {
    configPath: string;
    dryRun: boolean;
    paths: ReturnType<typeof resolveRuntimePaths>;
    uninstallHooks: boolean;
  },
): SetupStepResult {
  if (options.dryRun) {
    return ok(
      options.uninstallHooks
        ? `would remove hooks from ${options.configPath}`
        : `would install hooks into ${options.configPath}`,
    );
  }

  const codexHooksPath = agent === "codex"
    ? join(dirname(options.configPath), "hooks.json")
    : undefined;

  const result = agent === "claude-code"
    ? (options.uninstallHooks
        ? uninstallClaudeCodeHooks({ configPath: options.configPath })
        : installClaudeCodeHooks({
            configPath: options.configPath,
            cliPath: options.paths.runtimeCliPath,
            nodePath: options.paths.runtimeNodePath,
          }))
    : (options.uninstallHooks
        ? uninstallCodexHooks({ configPath: options.configPath, hooksPath: codexHooksPath })
        : installCodexHooks({
            configPath: options.configPath,
            hooksPath: codexHooksPath,
            cliPath: options.paths.runtimeCliPath,
            nodePath: options.paths.runtimeNodePath,
          }));

  return {
    enabled: true,
    ok: result.ok,
    message: result.message,
  };
}

function resolveTargetAgents(target?: AgentName[]): AgentName[] {
  if (target && target.length > 0) {
    return [...new Set(target)];
  }

  const detected: AgentName[] = [];
  if (detectAgent("codex")) detected.push("codex");
  if (detectAgent("claude-code")) detected.push("claude-code");
  return detected;
}

function detectAgent(agent: AgentName): boolean {
  if (agent === "codex") {
    return hasCommand("codex") || existsSync(join(resolveUserHomeDir(), ".codex", "config.toml"));
  }
  return hasCommand("claude") || existsSync(join(resolveUserHomeDir(), ".claude", "settings.json"));
}

function resolveHookConfigPath(agent: AgentName, scope: SetupScope, cwd: string): string {
  if (scope === "project") {
    return agent === "codex"
      ? join(cwd, ".codex", "config.toml")
      : join(cwd, ".claude", "settings.json");
  }

  return agent === "codex"
    ? join(resolveUserHomeDir(), ".codex", "config.toml")
    : join(resolveUserHomeDir(), ".claude", "settings.json");
}

function defaultRunner(command: string, args: string[]) {
  execFileSync(command, args, stdioOpts());
}

function tryRun(runner: CommandRunner, command: string, args: string[]) {
  try {
    runner(command, args);
  } catch {
    return;
  }
}

function stdioOpts() {
  return {
    stdio: "ignore" as const,
  };
}

function ok(message: string): SetupStepResult {
  return { enabled: true, ok: true, message };
}

function skipped(message: string): SetupStepResult {
  return { enabled: false, ok: false, message };
}
