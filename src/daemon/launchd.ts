import { chmodSync, closeSync, existsSync, mkdirSync, openSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { ensureLaunchdStarted } from "./launchd-start.js";
import {
  associatedBundleIdentifiers,
  findRecallAppIdentity,
  launchdPlistIdentity,
} from "./macos-app-identity.js";
import {
  readDaemonProviderEnvironment,
  resolveDaemonProviderEnvironment,
  type DaemonProviderEnvironment,
} from "./provider-env.js";

const DEFAULT_LABEL = "com.recall.daemon";

export interface LaunchdOptions {
  label?: string;
  port?: number;
  dataDir?: string;
  nodePath?: string;
  daemonScript?: string;
  maintenanceIntervalSeconds?: number;
  repoRoots?: string;
  repoOverride?: string;
  embeddingProvider?: string;
  embeddingDims?: string;
  embeddingsDisabled?: string;
}

export interface LaunchdStatus {
  label: string;
  plistPath: string;
  installed: boolean;
  loaded: boolean;
  state?: string;
}

export function installLaunchAgent(opts: LaunchdOptions = {}): LaunchdStatus {
  assertDarwin();

  const plistPath = launchAgentPlistPath(opts.label);
  mkdirSync(dirname(plistPath), { recursive: true });
  const cfg = withLaunchAgentWriteLock(plistPath, () => {
    // Resolve after acquiring the lock so a second explicit install does not
    // render an older snapshot of the existing plist's inherited settings.
    // An explicit install owns its requested label and runtime settings, even
    // when it reuses a plist whose current Label differs from its filename.
    const cfg = resolveConfig(opts, { preferRequestedLabel: true });
    mkdirSync(dirname(cfg.stdoutPath), { recursive: true });
    writeFileSync(cfg.plistPath, renderPlist(cfg), { mode: 0o600 });
    chmodSync(cfg.plistPath, 0o600);
    return cfg;
  });

  // `install` is explicit configuration: reload even an existing job so the
  // requested runtime and options take effect. Metadata-only migration is
  // intentionally confined to `startLaunchAgent` below.
  tryRun("launchctl", ["bootout", domainTarget(), cfg.plistPath]);
  execFileSync("launchctl", ["bootstrap", domainTarget(), cfg.plistPath], stdioOpts());
  execFileSync("launchctl", ["enable", `${domainTarget()}/${cfg.label}`], stdioOpts());
  // RunAtLoad has already spawned the job; `-k` would kill it and trigger
  // launchd's 10-second respawn throttle.
  execFileSync("launchctl", ["kickstart", `${domainTarget()}/${cfg.label}`], stdioOpts());

  return getLaunchAgentStatusForConfig(cfg);
}

export function uninstallLaunchAgent(label?: string): LaunchdStatus {
  assertDarwin();

  const cfg = resolveConfig({ label });
  tryRun("launchctl", ["bootout", domainTarget(), cfg.plistPath]);
  tryRun("launchctl", ["disable", `${domainTarget()}/${cfg.label}`]);
  rmSync(cfg.plistPath, { force: true });

  return getLaunchAgentStatusForConfig(cfg);
}

export function startLaunchAgent(label?: string): LaunchdStatus {
  assertDarwin();
  const cfg = resolveConfig({ label });
  if (!exists(cfg.plistPath)) {
    throw new Error(`LaunchAgent not installed: ${cfg.plistPath}`);
  }
  persistAppAssociation(cfg);
  // Static plist metadata needs a later reload. Starting a loaded-but-stopped
  // job still needs a non-killing kickstart, though.
  execFileSync("launchctl", ["enable", `${domainTarget()}/${cfg.label}`], stdioOpts());
  ensureLaunchdStarted(domainTarget(), cfg.label, cfg.plistPath);
  return getLaunchAgentStatusForConfig(cfg);
}

export function stopLaunchAgent(label?: string): LaunchdStatus {
  assertDarwin();
  const cfg = resolveConfig({ label });
  if (exists(cfg.plistPath)) {
    tryRun("launchctl", ["bootout", domainTarget(), cfg.plistPath]);
  }
  return getLaunchAgentStatusForConfig(cfg);
}

export function getLaunchAgentStatus(label?: string): LaunchdStatus {
  assertDarwin();

  const cfg = resolveConfig({ label });
  return getLaunchAgentStatusForConfig(cfg);
}

function getLaunchAgentStatusForConfig(cfg: ReturnType<typeof resolveConfig>): LaunchdStatus {
  const installed = exists(cfg.plistPath);
  const output = tryOutput("launchctl", ["print", `${domainTarget()}/${cfg.label}`]);

  return {
    label: cfg.label,
    plistPath: cfg.plistPath,
    installed,
    loaded: output.ok,
    state: output.ok ? extractState(output.output) : undefined,
  };
}

export function getLaunchAgentInfo(label?: string): string {
  assertDarwin();

  const cfg = resolveConfig({ label });
  const status = getLaunchAgentStatusForConfig(cfg);
  const installed = readInstalledConfig(cfg.plistPath);
  const lines = [
    `Label:      ${status.label}`,
    `Plist:      ${cfg.plistPath}`,
    `Installed:  ${status.installed ? "yes" : "no"}`,
    `Loaded:     ${status.loaded ? "yes" : "no"}`,
  ];

  if (status.state) {
    lines.push(`State:      ${status.state}`);
  }

  lines.push(`Port:       ${installed?.port ?? cfg.port}`);
  lines.push(`Data dir:   ${installed?.dataDir ?? cfg.dataDir}`);
  if (installed?.repoRoots ?? cfg.repoRoots) {
    lines.push(`Repos:      ${installed?.repoRoots ?? cfg.repoRoots}`);
  }
  if (installed?.repoOverride ?? cfg.repoOverride) {
    lines.push(`Repo:       ${installed?.repoOverride ?? cfg.repoOverride}`);
  }
  if (installed?.embeddingProvider ?? cfg.embeddingProvider) {
    lines.push(`EmbedProv:  ${installed?.embeddingProvider ?? cfg.embeddingProvider}`);
  }
  if (installed?.embeddingDims ?? cfg.embeddingDims) {
    lines.push(`EmbedDims:  ${installed?.embeddingDims ?? cfg.embeddingDims}`);
  }
  if (installed?.embeddingsDisabled ?? cfg.embeddingsDisabled) {
    lines.push(`EmbedOff:   ${installed?.embeddingsDisabled ?? cfg.embeddingsDisabled}`);
  }
  lines.push(`Node:       ${installed?.nodePath ?? cfg.nodePath}`);
  lines.push(`Script:     ${installed?.daemonScript ?? cfg.daemonScript}`);
  lines.push(`Maintain:   ${installed?.maintenanceIntervalSeconds ?? cfg.maintenanceIntervalSeconds}s`);
  lines.push(`Stdout:     ${installed?.stdoutPath ?? cfg.stdoutPath}`);
  lines.push(`Stderr:     ${installed?.stderrPath ?? cfg.stderrPath}`);

  return lines.join("\n");
}

function resolveConfig(
  opts: LaunchdOptions,
  { preferRequestedLabel = false }: { preferRequestedLabel?: boolean } = {},
) {
  // `label` selects a plist filename. Its stored Label is launchd's service
  // identity and can legitimately differ from that filename.
  const plistLabel = opts.label ?? DEFAULT_LABEL;
  const home = homedir();
  const port = opts.port ?? parseInt(process.env.RECALL_PORT ?? "7890", 10);
  const maintenanceIntervalSeconds =
    opts.maintenanceIntervalSeconds ??
    parseInt(process.env.RECALL_MAINTENANCE_INTERVAL_SECONDS ?? "3600", 10);
  const dataDir = resolve(
    opts.dataDir ??
      process.env.RECALL_DATA_DIR ??
      join(home, ".recall"),
  );
  const nodePath = resolve(opts.nodePath ?? process.execPath);
  const daemonScript = resolve(
    opts.daemonScript ?? join(process.cwd(), "dist", "daemon.js"),
  );
  const plistPath = launchAgentPlistPath(plistLabel, home);
  const logDir = join(dataDir, "logs");
  const installed = readInstalledConfig(plistPath);

  return {
    label: preferRequestedLabel
      ? opts.label ?? installed?.label ?? plistLabel
      : installed?.label ?? plistLabel,
    port,
    maintenanceIntervalSeconds,
    dataDir,
    nodePath,
    daemonScript,
    plistPath,
    stdoutPath: join(logDir, "daemon.stdout.log"),
    stderrPath: join(logDir, "daemon.stderr.log"),
    repoRoots: opts.repoRoots ?? process.env.RECALL_REPO_ROOTS,
    repoOverride: opts.repoOverride ?? process.env.RECALL_REPO_OVERRIDE ?? installed?.repoOverride,
    embeddingProvider: opts.embeddingProvider ?? process.env.RECALL_EMBEDDING_PROVIDER,
    embeddingDims: opts.embeddingDims ?? process.env.RECALL_EMBEDDING_DIMS,
    embeddingsDisabled: opts.embeddingsDisabled ?? process.env.RECALL_EMBEDDINGS_DISABLED,
    providerEnvironment: resolveDaemonProviderEnvironment(
      process.env,
      installed?.providerEnvironment,
    ),
    installed,
  };
}

function renderPlist(cfg: ReturnType<typeof resolveConfig>): string {
  const env: Record<string, string> = {
    RECALL_PORT: String(cfg.port),
    RECALL_MAINTENANCE_INTERVAL_SECONDS: String(cfg.maintenanceIntervalSeconds),
    RECALL_DATA_DIR: cfg.dataDir,
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    ...(cfg.repoRoots ? { RECALL_REPO_ROOTS: cfg.repoRoots } : {}),
    ...(cfg.repoOverride ? { RECALL_REPO_OVERRIDE: cfg.repoOverride } : {}),
    ...(cfg.embeddingProvider ? { RECALL_EMBEDDING_PROVIDER: cfg.embeddingProvider } : {}),
    ...(cfg.embeddingDims ? { RECALL_EMBEDDING_DIMS: cfg.embeddingDims } : {}),
    ...(cfg.embeddingsDisabled ? { RECALL_EMBEDDINGS_DISABLED: cfg.embeddingsDisabled } : {}),
    ...cfg.providerEnvironment,
  };
  const environmentXml = Object.entries(env)
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>
    <string>${escapeXml(value)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(cfg.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(cfg.nodePath)}</string>
    <string>${escapeXml(cfg.daemonScript)}</string>
  </array>
${renderAssociatedBundleIdentifiers(cfg)}
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(process.cwd())}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(cfg.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(cfg.stderrPath)}</string>
</dict>
</plist>
`;
}

function renderAssociatedBundleIdentifiers(cfg: ReturnType<typeof resolveConfig>): string {
  const identity = findRecallAppIdentity(cfg.nodePath, cfg.daemonScript);
  if (!identity) return "";
  return `  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>${escapeXml(identity.bundleIdentifier)}</string>
  </array>
`;
}

function persistAppAssociation(cfg: ReturnType<typeof resolveConfig>): void {
  withLaunchAgentWriteLock(cfg.plistPath, () => {
    // Read after acquiring the lock: another CLI invocation might just have
    // added an association that a stale config snapshot would overwrite.
    const installed = readInstalledConfig(cfg.plistPath);
    if (!installed?.nodePath || !installed.daemonScript) return;
    const identity = findRecallAppIdentity(installed.nodePath, installed.daemonScript);
    if (!identity) return;

    const identifiers = associatedBundleIdentifiers(installed.associatedBundleIdentifiers);
    if (sameIdentifiers(identifiers, installed.associatedBundleIdentifiers)) return;
    const value = `<array>${identifiers.map((identifier) => `<string>${escapeXml(identifier)}</string>`).join("")}</array>`;
    const operation = installed.hasAssociatedBundleIdentifiers ? "-replace" : "-insert";
    execFileSync("plutil", [operation, "AssociatedBundleIdentifiers", "-xml", value, cfg.plistPath], stdioOpts());
    chmodSync(cfg.plistPath, 0o600);
  });
}

function domainTarget(): string {
  const uid = process.getuid?.();
  if (uid == null) {
    throw new Error("Could not determine current macOS user id");
  }
  return `gui/${uid}`;
}

function extractState(output: string): string | undefined {
  const line = output.split("\n").find((item) => item.trim().startsWith("state = "));
  if (!line) return undefined;
  return line.split("=").slice(1).join("=").trim();
}

function tryRun(cmd: string, args: string[]) {
  try {
    execFileSync(cmd, args, stdioOpts());
  } catch {
    return;
  }
}

function tryOutput(cmd: string, args: string[]) {
  try {
    const output = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output };
  } catch (error: any) {
    return {
      ok: false,
      output: String(error?.stdout ?? error?.stderr ?? error?.message ?? ""),
    };
  }
}

function readInstalledConfig(plistPath: string): {
  label?: string;
  nodePath?: string;
  daemonScript?: string;
      port?: string;
      maintenanceIntervalSeconds?: string;
      dataDir?: string;
      repoRoots?: string;
      repoOverride?: string;
      embeddingProvider?: string;
      embeddingDims?: string;
      embeddingsDisabled?: string;
      providerEnvironment?: DaemonProviderEnvironment;
      stdoutPath?: string;
      stderrPath?: string;
      associatedBundleIdentifiers: unknown;
      hasAssociatedBundleIdentifiers: boolean;
} | null {
  if (!exists(plistPath)) return null;

  try {
    const raw = execFileSync("plutil", ["-convert", "json", "-o", "-", plistPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(raw);
    const identity = launchdPlistIdentity(parsed);
    return {
      label: identity.label,
      nodePath: identity.nodePath,
      daemonScript: identity.daemonScript,
      port: parsed?.EnvironmentVariables?.RECALL_PORT,
      maintenanceIntervalSeconds: parsed?.EnvironmentVariables?.RECALL_MAINTENANCE_INTERVAL_SECONDS,
      dataDir: parsed?.EnvironmentVariables?.RECALL_DATA_DIR,
      repoRoots: parsed?.EnvironmentVariables?.RECALL_REPO_ROOTS,
      repoOverride: parsed?.EnvironmentVariables?.RECALL_REPO_OVERRIDE,
      embeddingProvider: parsed?.EnvironmentVariables?.RECALL_EMBEDDING_PROVIDER,
      embeddingDims: parsed?.EnvironmentVariables?.RECALL_EMBEDDING_DIMS,
      embeddingsDisabled: parsed?.EnvironmentVariables?.RECALL_EMBEDDINGS_DISABLED,
      providerEnvironment: readDaemonProviderEnvironment(
        parsed?.EnvironmentVariables ?? {},
      ),
      stdoutPath: parsed?.StandardOutPath,
      stderrPath: parsed?.StandardErrorPath,
      associatedBundleIdentifiers: identity.associatedBundleIdentifiers,
      hasAssociatedBundleIdentifiers: identity.hasAssociatedBundleIdentifiers,
    };
  } catch {
    return null;
  }
}

function sameIdentifiers(next: string[], existing: unknown): boolean {
  const current = typeof existing === "string"
    ? [existing]
    : Array.isArray(existing)
      ? existing.filter((value): value is string => typeof value === "string")
      : [];
  return next.length === current.length && next.every((value, index) => value === current[index]);
}

function launchAgentPlistPath(label = DEFAULT_LABEL, home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

function withLaunchAgentWriteLock<T>(plistPath: string, action: () => T): T {
  const lockPath = `${plistPath}.recall-identity.lock`;
  const deadline = Date.now() + 5_000;
  let descriptor: number | undefined;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) unlinkSync(lockPath);
      } catch (statError: any) {
        if (statError?.code !== "ENOENT") throw statError;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting to update launchd plist: ${plistPath}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return action();
  } finally {
    closeSync(descriptor);
    unlinkSync(lockPath);
  }
}

function stdioOpts() {
  return {
    stdio: "pipe" as const,
  };
}

function exists(path: string): boolean {
  return existsSync(path);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function assertDarwin() {
  if (process.platform !== "darwin") {
    throw new Error("launchd daemon install is only supported on macOS");
  }
}
