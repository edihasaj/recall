import {
  installLaunchAgent,
  uninstallLaunchAgent,
  startLaunchAgent,
  stopLaunchAgent,
  getLaunchAgentStatus,
  getLaunchAgentInfo,
  type LaunchdOptions,
} from "./launchd.js";
import {
  installSystemdUnit,
  uninstallSystemdUnit,
  startSystemdUnit,
  stopSystemdUnit,
  getSystemdStatus,
  getSystemdInfo,
  type SystemdOptions,
} from "./systemd.js";

export type ServiceOptions = LaunchdOptions & SystemdOptions;

export interface ServiceStatus {
  label: string;
  installed: boolean;
  loaded: boolean;
  state?: string;
}

const isLinux = process.platform === "linux";
const isDarwin = process.platform === "darwin";

function unsupported(): never {
  throw new Error(
    `Recall daemon service is only supported on macOS (launchd) and Linux (systemd). Current platform: ${process.platform}`,
  );
}

export function installService(opts: ServiceOptions = {}): ServiceStatus {
  if (isDarwin) return installLaunchAgent(opts);
  if (isLinux) return installSystemdUnit(opts);
  unsupported();
}

export function uninstallService(label?: string): ServiceStatus {
  if (isDarwin) return uninstallLaunchAgent(label);
  if (isLinux) return uninstallSystemdUnit(label);
  unsupported();
}

export function startService(label?: string): ServiceStatus {
  if (isDarwin) return startLaunchAgent(label);
  if (isLinux) return startSystemdUnit(label);
  unsupported();
}

export function stopService(label?: string): ServiceStatus {
  if (isDarwin) return stopLaunchAgent(label);
  if (isLinux) return stopSystemdUnit(label);
  unsupported();
}

export function getServiceStatus(label?: string): ServiceStatus {
  if (isDarwin) return getLaunchAgentStatus(label);
  if (isLinux) return getSystemdStatus(label);
  unsupported();
}

export function getServiceInfo(label?: string): string {
  if (isDarwin) return getLaunchAgentInfo(label);
  if (isLinux) return getSystemdInfo(label);
  unsupported();
}

export function defaultServiceLabel(): string {
  return isLinux ? "recall-daemon" : "com.recall.daemon";
}
