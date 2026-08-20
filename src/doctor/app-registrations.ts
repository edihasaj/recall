/**
 * Stray Recall.app registrations (macOS).
 *
 * LaunchServices registers every Recall.app bundle it sees, not just the
 * installed one. A local Xcode build under `build/DerivedData`, a bundle
 * sitting in the Trash after an upgrade, or an old unpacked release in /tmp
 * each become another "Recall" offered in Spotlight and Open With. One real
 * machine had accumulated 31 of them.
 *
 * The causes are fixed (the build tree is excluded from indexing and the
 * installer unregisters the previous bundle before trashing it), but a
 * database that already carries strays never heals on its own. This module
 * reports them, and `recall doctor --fix` unregisters them.
 *
 * Unregistering only edits the LaunchServices database; it never touches the
 * files on disk.
 */

import { execFileSync } from "node:child_process";

export const INSTALLED_APP_PATH = "/Applications/Recall.app";

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

export interface AppRegistrationReport {
  /** Null when the platform or lsregister makes the check inapplicable. */
  supported: boolean;
  installed_registered: boolean;
  /** Registered Recall.app bundles that are not the installed one. */
  stray_paths: string[];
}

function runLsregister(args: string[]): string | null {
  try {
    return execFileSync(LSREGISTER, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

// `lsregister -dump` emits "path:  <path> (0x1234)" lines among much else.
//
// Bundle names are not uniformly suffixed. Alongside `Recall.app` a real dump
// carries `Recall.app.old.1349` from the installer and `Recall.app 11-52-09-108.app`
// from a Finder collision, so anchoring on a trailing `.app` silently misses
// most strays. Capture the whole path, then keep the ones that are a Recall
// bundle.
const PATH_LINE_RE = /^\s*path:\s+(\/\S.*?)(?:\s+\(0x[0-9a-f]+\))?\s*$/i;
const RECALL_BUNDLE_RE = /\/Recall[^/]*\.app(?:[^/]*)?$/i;

export function parseRegisteredAppPaths(dump: string): string[] {
  const paths = new Set<string>();
  for (const line of dump.split("\n")) {
    const match = line.match(PATH_LINE_RE);
    if (!match) continue;
    const path = match[1];
    if (RECALL_BUNDLE_RE.test(path)) paths.add(path);
  }
  return [...paths].sort();
}

export function inspectAppRegistrations(
  options: { dump?: string | null; platform?: NodeJS.Platform } = {},
): AppRegistrationReport {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return { supported: false, installed_registered: false, stray_paths: [] };
  }

  const dump = options.dump !== undefined ? options.dump : runLsregister(["-dump"]);
  if (dump == null) {
    return { supported: false, installed_registered: false, stray_paths: [] };
  }

  const registered = parseRegisteredAppPaths(dump);
  return {
    supported: true,
    installed_registered: registered.includes(INSTALLED_APP_PATH),
    stray_paths: registered.filter((path) => path !== INSTALLED_APP_PATH),
  };
}

export interface UnregisterResult {
  unregistered: string[];
  failed: string[];
}

/**
 * Drop stray bundles from LaunchServices. Files are never removed — a stray
 * may well be a build product the user still wants on disk, just not offered
 * as an installed application.
 */
export function unregisterStrayApps(
  strayPaths: readonly string[],
  options: { platform?: NodeJS.Platform; run?: (path: string) => boolean } = {},
): UnregisterResult {
  const platform = options.platform ?? process.platform;
  const result: UnregisterResult = { unregistered: [], failed: [] };
  if (platform !== "darwin") return result;

  const run = options.run ?? ((path: string) => runLsregister(["-u", path]) !== null);
  for (const path of strayPaths) {
    if (path === INSTALLED_APP_PATH) continue;
    if (run(path)) result.unregistered.push(path);
    else result.failed.push(path);
  }
  return result;
}
