import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export interface LocalSetupOptions {
  appPath?: string;
  codex?: boolean;
  claude?: boolean;
}

export interface LocalSetupResult {
  appPath: string;
  runtimeNodePath: string;
  runtimeMcpPath: string;
  codex: SetupStepResult;
  claude: SetupStepResult;
}

export interface SetupStepResult {
  enabled: boolean;
  ok: boolean;
  message: string;
}

export function resolveRuntimePaths(appPath?: string) {
  const resolvedAppPath = appPath ?? "/Applications/Recall.app";
  const runtimeRoot = join(resolvedAppPath, "Contents", "Resources", "Runtime");
  return {
    appPath: resolvedAppPath,
    runtimeNodePath: join(runtimeRoot, "bin", "node"),
    runtimeMcpPath: join(runtimeRoot, "dist", "mcp.js"),
  };
}

export function runLocalSetup(opts: LocalSetupOptions = {}): LocalSetupResult {
  const targetCodex = opts.codex ?? true;
  const targetClaude = opts.claude ?? true;
  const paths = resolveRuntimePaths(opts.appPath);

  if (!existsSync(paths.appPath)) {
    throw new Error(`Recall.app not found at ${paths.appPath}`);
  }
  if (!existsSync(paths.runtimeNodePath)) {
    throw new Error(`Bundled node runtime not found at ${paths.runtimeNodePath}`);
  }
  if (!existsSync(paths.runtimeMcpPath)) {
    throw new Error(`Bundled MCP entry not found at ${paths.runtimeMcpPath}`);
  }

  return {
    ...paths,
    codex: targetCodex
      ? configureCodex(paths.runtimeNodePath, paths.runtimeMcpPath)
      : skipped("skipped"),
    claude: targetClaude
      ? configureClaude(paths.runtimeNodePath, paths.runtimeMcpPath)
      : skipped("skipped"),
  };
}

function configureCodex(nodePath: string, mcpPath: string): SetupStepResult {
  if (!hasCommand("codex")) return skipped("codex not found on PATH");

  tryRun("codex", ["mcp", "remove", "recall"]);
  execFileSync("codex", ["mcp", "add", "recall", "--", nodePath, mcpPath], stdioOpts());
  return ok("configured global Codex MCP server");
}

function configureClaude(nodePath: string, mcpPath: string): SetupStepResult {
  if (!hasCommand("claude")) return skipped("claude not found on PATH");

  tryRun("claude", ["mcp", "remove", "recall", "-s", "user"]);
  execFileSync("claude", ["mcp", "add", "-s", "user", "recall", nodePath, mcpPath], stdioOpts());
  return ok("configured user Claude MCP server");
}

function hasCommand(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function tryRun(command: string, args: string[]) {
  try {
    execFileSync(command, args, stdioOpts());
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
