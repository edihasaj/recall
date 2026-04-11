import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const DEFAULT_LABEL = "com.recall.daemon";

export interface LaunchdOptions {
  label?: string;
  port?: number;
  dataDir?: string;
  nodePath?: string;
  daemonScript?: string;
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

  const cfg = resolveConfig(opts);
  mkdirSync(dirname(cfg.plistPath), { recursive: true });
  mkdirSync(dirname(cfg.stdoutPath), { recursive: true });

  writeFileSync(cfg.plistPath, renderPlist(cfg));

  tryRun("launchctl", ["bootout", domainTarget(), cfg.plistPath]);
  execFileSync("launchctl", ["bootstrap", domainTarget(), cfg.plistPath], stdioOpts());
  execFileSync("launchctl", ["enable", `${domainTarget()}/${cfg.label}`], stdioOpts());
  execFileSync("launchctl", ["kickstart", "-k", `${domainTarget()}/${cfg.label}`], stdioOpts());

  return getLaunchAgentStatus(cfg.label);
}

export function uninstallLaunchAgent(label = DEFAULT_LABEL): LaunchdStatus {
  assertDarwin();

  const cfg = resolveConfig({ label });
  tryRun("launchctl", ["bootout", domainTarget(), cfg.plistPath]);
  tryRun("launchctl", ["disable", `${domainTarget()}/${cfg.label}`]);
  rmSync(cfg.plistPath, { force: true });

  return getLaunchAgentStatus(cfg.label);
}

export function startLaunchAgent(label = DEFAULT_LABEL): LaunchdStatus {
  assertDarwin();
  const cfg = resolveConfig({ label });
  if (!exists(cfg.plistPath)) {
    throw new Error(`LaunchAgent not installed: ${cfg.plistPath}`);
  }
  execFileSync("launchctl", ["enable", `${domainTarget()}/${cfg.label}`], stdioOpts());
  tryRun("launchctl", ["bootstrap", domainTarget(), cfg.plistPath]);
  execFileSync("launchctl", ["kickstart", "-k", `${domainTarget()}/${cfg.label}`], stdioOpts());
  return getLaunchAgentStatus(cfg.label);
}

export function stopLaunchAgent(label = DEFAULT_LABEL): LaunchdStatus {
  assertDarwin();
  const cfg = resolveConfig({ label });
  if (exists(cfg.plistPath)) {
    tryRun("launchctl", ["bootout", domainTarget(), cfg.plistPath]);
  }
  return getLaunchAgentStatus(cfg.label);
}

export function getLaunchAgentStatus(label = DEFAULT_LABEL): LaunchdStatus {
  assertDarwin();

  const cfg = resolveConfig({ label });
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

export function getLaunchAgentInfo(label = DEFAULT_LABEL): string {
  assertDarwin();

  const cfg = resolveConfig({ label });
  const status = getLaunchAgentStatus(label);
  const lines = [
    `Label:      ${status.label}`,
    `Plist:      ${cfg.plistPath}`,
    `Installed:  ${status.installed ? "yes" : "no"}`,
    `Loaded:     ${status.loaded ? "yes" : "no"}`,
  ];

  if (status.state) {
    lines.push(`State:      ${status.state}`);
  }

  lines.push(`Port:       ${cfg.port}`);
  lines.push(`Data dir:   ${cfg.dataDir}`);
  lines.push(`Node:       ${cfg.nodePath}`);
  lines.push(`Script:     ${cfg.daemonScript}`);
  lines.push(`Stdout:     ${cfg.stdoutPath}`);
  lines.push(`Stderr:     ${cfg.stderrPath}`);

  return lines.join("\n");
}

function resolveConfig(opts: LaunchdOptions) {
  const label = opts.label ?? DEFAULT_LABEL;
  const home = homedir();
  const port = opts.port ?? parseInt(process.env.RECALL_PORT ?? "7890", 10);
  const dataDir = resolve(
    opts.dataDir ??
      process.env.RECALL_DATA_DIR ??
      join(home, ".recall"),
  );
  const nodePath = resolve(opts.nodePath ?? process.execPath);
  const daemonScript = resolve(
    opts.daemonScript ?? join(process.cwd(), "dist", "daemon.js"),
  );
  const plistPath = join(home, "Library", "LaunchAgents", `${label}.plist`);
  const logDir = join(dataDir, "logs");

  return {
    label,
    port,
    dataDir,
    nodePath,
    daemonScript,
    plistPath,
    stdoutPath: join(logDir, "daemon.stdout.log"),
    stderrPath: join(logDir, "daemon.stderr.log"),
  };
}

function renderPlist(cfg: ReturnType<typeof resolveConfig>): string {
  const env = {
    RECALL_PORT: String(cfg.port),
    RECALL_DATA_DIR: cfg.dataDir,
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
  };

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
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(env.PATH)}</string>
    <key>RECALL_PORT</key>
    <string>${escapeXml(env.RECALL_PORT)}</string>
    <key>RECALL_DATA_DIR</key>
    <string>${escapeXml(env.RECALL_DATA_DIR)}</string>
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
