import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const DEFAULT_LABEL = "recall-daemon";

export interface SystemdOptions {
  label?: string;
  port?: number;
  dataDir?: string;
  nodePath?: string;
  daemonScript?: string;
  maintenanceIntervalSeconds?: number;
  repoRoots?: string;
  embeddingProvider?: string;
  embeddingDims?: string;
  embeddingsDisabled?: string;
}

export interface SystemdStatus {
  label: string;
  unitPath: string;
  installed: boolean;
  loaded: boolean;
  state?: string;
}

export function installSystemdUnit(opts: SystemdOptions = {}): SystemdStatus {
  assertLinux();

  const cfg = resolveConfig(opts);
  mkdirSync(dirname(cfg.unitPath), { recursive: true });
  mkdirSync(cfg.logDir, { recursive: true });

  writeFileSync(cfg.unitPath, renderUnit(cfg));

  systemctl(["--user", "daemon-reload"]);
  systemctl(["--user", "enable", "--now", `${cfg.label}.service`]);

  return getSystemdStatus(cfg.label);
}

export function uninstallSystemdUnit(label = DEFAULT_LABEL): SystemdStatus {
  assertLinux();

  const cfg = resolveConfig({ label });
  trySystemctl(["--user", "disable", "--now", `${cfg.label}.service`]);
  rmSync(cfg.unitPath, { force: true });
  trySystemctl(["--user", "daemon-reload"]);

  return getSystemdStatus(cfg.label);
}

export function startSystemdUnit(label = DEFAULT_LABEL): SystemdStatus {
  assertLinux();
  const cfg = resolveConfig({ label });
  if (!existsSync(cfg.unitPath)) {
    throw new Error(`systemd unit not installed: ${cfg.unitPath}`);
  }
  systemctl(["--user", "start", `${cfg.label}.service`]);
  return getSystemdStatus(cfg.label);
}

export function stopSystemdUnit(label = DEFAULT_LABEL): SystemdStatus {
  assertLinux();
  const cfg = resolveConfig({ label });
  if (existsSync(cfg.unitPath)) {
    trySystemctl(["--user", "stop", `${cfg.label}.service`]);
  }
  return getSystemdStatus(cfg.label);
}

export function getSystemdStatus(label = DEFAULT_LABEL): SystemdStatus {
  assertLinux();

  const cfg = resolveConfig({ label });
  const installed = existsSync(cfg.unitPath);
  const active = trySystemctlOutput(["--user", "is-active", `${cfg.label}.service`]);
  const loaded = active.ok && active.output.trim() === "active";
  const state = active.output.trim() || undefined;

  return {
    label: cfg.label,
    unitPath: cfg.unitPath,
    installed,
    loaded,
    state,
  };
}

export function getSystemdInfo(label = DEFAULT_LABEL): string {
  assertLinux();

  const cfg = resolveConfig({ label });
  const status = getSystemdStatus(label);
  const installed = readInstalledConfig(cfg.unitPath);
  const lines = [
    `Label:      ${status.label}`,
    `Unit:       ${cfg.unitPath}`,
    `Installed:  ${status.installed ? "yes" : "no"}`,
    `Loaded:     ${status.loaded ? "yes" : "no"}`,
  ];
  if (status.state) lines.push(`State:      ${status.state}`);
  lines.push(`Port:       ${installed?.port ?? cfg.port}`);
  lines.push(`Data dir:   ${installed?.dataDir ?? cfg.dataDir}`);
  if (installed?.repoRoots ?? cfg.repoRoots) {
    lines.push(`Repos:      ${installed?.repoRoots ?? cfg.repoRoots}`);
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
  lines.push(`Logs:       journalctl --user -u ${cfg.label}.service`);

  return lines.join("\n");
}

function resolveConfig(opts: SystemdOptions) {
  const label = opts.label ?? DEFAULT_LABEL;
  const home = homedir();
  const port = opts.port ?? parseInt(process.env.RECALL_PORT ?? "7890", 10);
  const maintenanceIntervalSeconds =
    opts.maintenanceIntervalSeconds ??
    parseInt(process.env.RECALL_MAINTENANCE_INTERVAL_SECONDS ?? "300", 10);
  const dataDir = resolve(
    opts.dataDir ?? process.env.RECALL_DATA_DIR ?? join(home, ".recall"),
  );
  const nodePath = resolve(opts.nodePath ?? process.execPath);
  const daemonScript = resolve(
    opts.daemonScript ?? defaultDaemonScript(),
  );
  const configHome = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  const unitPath = join(configHome, "systemd", "user", `${label}.service`);
  const logDir = join(dataDir, "logs");

  return {
    label,
    port,
    maintenanceIntervalSeconds,
    dataDir,
    nodePath,
    daemonScript,
    unitPath,
    logDir,
    repoRoots: opts.repoRoots ?? process.env.RECALL_REPO_ROOTS,
    embeddingProvider: opts.embeddingProvider ?? process.env.RECALL_EMBEDDING_PROVIDER,
    embeddingDims: opts.embeddingDims ?? process.env.RECALL_EMBEDDING_DIMS,
    embeddingsDisabled: opts.embeddingsDisabled ?? process.env.RECALL_EMBEDDINGS_DISABLED,
  };
}

function defaultDaemonScript(): string {
  // Co-located with this module under dist/
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "daemon.js");
}

function renderUnit(cfg: ReturnType<typeof resolveConfig>): string {
  const envLines = [
    `Environment=PATH=${process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin"}`,
    `Environment=RECALL_PORT=${cfg.port}`,
    `Environment=RECALL_MAINTENANCE_INTERVAL_SECONDS=${cfg.maintenanceIntervalSeconds}`,
    `Environment=RECALL_DATA_DIR=${cfg.dataDir}`,
  ];
  if (cfg.repoRoots) envLines.push(`Environment=RECALL_REPO_ROOTS=${cfg.repoRoots}`);
  if (cfg.embeddingProvider) envLines.push(`Environment=RECALL_EMBEDDING_PROVIDER=${cfg.embeddingProvider}`);
  if (cfg.embeddingDims) envLines.push(`Environment=RECALL_EMBEDDING_DIMS=${cfg.embeddingDims}`);
  if (cfg.embeddingsDisabled) envLines.push(`Environment=RECALL_EMBEDDINGS_DISABLED=${cfg.embeddingsDisabled}`);

  return `[Unit]
Description=Recall local daemon
After=network.target

[Service]
Type=simple
ExecStart=${cfg.nodePath} ${cfg.daemonScript}
Restart=always
RestartSec=2
${envLines.join("\n")}

[Install]
WantedBy=default.target
`;
}

function readInstalledConfig(unitPath: string): {
  nodePath?: string;
  daemonScript?: string;
  port?: string;
  maintenanceIntervalSeconds?: string;
  dataDir?: string;
  repoRoots?: string;
  embeddingProvider?: string;
  embeddingDims?: string;
  embeddingsDisabled?: string;
} | null {
  if (!existsSync(unitPath)) return null;
  try {
    const raw = readFileSync(unitPath, "utf8");
    const exec = raw.match(/^ExecStart=(.+)$/m)?.[1]?.trim().split(/\s+/);
    const env: Record<string, string> = {};
    for (const m of raw.matchAll(/^Environment=([^=]+)=(.+)$/gm)) {
      env[m[1]] = m[2];
    }
    return {
      nodePath: exec?.[0],
      daemonScript: exec?.[1],
      port: env.RECALL_PORT,
      maintenanceIntervalSeconds: env.RECALL_MAINTENANCE_INTERVAL_SECONDS,
      dataDir: env.RECALL_DATA_DIR,
      repoRoots: env.RECALL_REPO_ROOTS,
      embeddingProvider: env.RECALL_EMBEDDING_PROVIDER,
      embeddingDims: env.RECALL_EMBEDDING_DIMS,
      embeddingsDisabled: env.RECALL_EMBEDDINGS_DISABLED,
    };
  } catch {
    return null;
  }
}

function systemctl(args: string[]) {
  execFileSync("systemctl", args, { stdio: "pipe" });
}

function trySystemctl(args: string[]) {
  try {
    execFileSync("systemctl", args, { stdio: "pipe" });
  } catch {
    return;
  }
}

function trySystemctlOutput(args: string[]) {
  try {
    const output = execFileSync("systemctl", args, {
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

function assertLinux() {
  if (process.platform !== "linux") {
    throw new Error("systemd daemon install is only supported on Linux");
  }
}
