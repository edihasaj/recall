import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const RECALL_APP_BUNDLE_IDENTIFIER = "com.edihasaj.recall";

export interface MacosAppIdentity {
  appPath: string;
  runtimePath: string;
  bundleIdentifier: typeof RECALL_APP_BUNDLE_IDENTIFIER;
}

export interface LaunchdPlistIdentity {
  label?: string;
  nodePath?: string;
  daemonScript?: string;
  associatedBundleIdentifiers: unknown;
  hasAssociatedBundleIdentifiers: boolean;
}

interface IdentityDependencies {
  realpath?: (path: string) => string;
  readBundleIdentifier?: (infoPlistPath: string) => string | undefined;
}

type PlistExtractor = (args: string[]) => string;

/**
 * Returns an app identity only for Recall's real bundled runtime. Paths are
 * canonicalized before their components are examined, so a symlink or a path
 * such as `Runtime-old` cannot accidentally receive the app association.
 */
export function findRecallAppIdentity(
  nodePath: string,
  daemonScript: string,
  dependencies: IdentityDependencies = {},
): MacosAppIdentity | undefined {
  const canonicalPath = dependencies.realpath ?? realpathSync;
  const readBundleIdentifier = dependencies.readBundleIdentifier ?? readRecallBundleIdentifier;

  try {
    const node = canonicalPath(nodePath);
    const daemon = canonicalPath(daemonScript);
    if (basename(node) !== "node" || basename(dirname(node)) !== "bin") return undefined;

    const runtimePath = dirname(dirname(node));
    if (
      basename(runtimePath) !== "Runtime" ||
      basename(dirname(runtimePath)) !== "Resources" ||
      basename(dirname(dirname(runtimePath))) !== "Contents"
    ) {
      return undefined;
    }

    const appPath = dirname(dirname(dirname(runtimePath)));
    if (!basename(appPath).endsWith(".app")) return undefined;
    if (node !== join(runtimePath, "bin", "node")) return undefined;
    if (daemon !== join(runtimePath, "dist", "daemon.js")) return undefined;

    const infoPlistPath = join(appPath, "Contents", "Info.plist");
    if (readBundleIdentifier(infoPlistPath) !== RECALL_APP_BUNDLE_IDENTIFIER) return undefined;

    return { appPath, runtimePath, bundleIdentifier: RECALL_APP_BUNDLE_IDENTIFIER };
  } catch {
    return undefined;
  }
}

/** Adds the app identity while leaving every unrelated launchd setting intact. */
export function associatedBundleIdentifiers(
  existing: unknown,
  bundleIdentifier = RECALL_APP_BUNDLE_IDENTIFIER,
): string[] {
  const identifiers = typeof existing === "string"
    ? [existing]
    : Array.isArray(existing)
      ? existing.filter((value): value is string => typeof value === "string")
      : [];
  return identifiers.includes(bundleIdentifier)
    ? identifiers
    : [...identifiers, bundleIdentifier];
}

/**
 * Read only the fields used to identify a pre-existing LaunchAgent. `Program`
 * is launchd's executable when present; ProgramArguments[0] is then merely
 * argv[0] and must not grant an app association by itself.
 */
export function launchdPlistIdentity(plist: unknown): LaunchdPlistIdentity {
  const record = isRecord(plist) ? plist : {};
  const programArguments = Array.isArray(record.ProgramArguments)
    ? record.ProgramArguments
    : [];
  return {
    label: stringValue(record.Label),
    nodePath: Object.hasOwn(record, "Program")
      ? stringValue(record.Program)
      : stringValue(programArguments[0]),
    daemonScript: stringValue(programArguments[1]),
    associatedBundleIdentifiers: record.AssociatedBundleIdentifiers,
    hasAssociatedBundleIdentifiers: Object.hasOwn(record, "AssociatedBundleIdentifiers"),
  };
}

export function readRecallBundleIdentifier(
  infoPlistPath: string,
  extract: PlistExtractor = (args) => execFileSync("plutil", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }),
): string | undefined {
  try {
    return extract(["-extract", "CFBundleIdentifier", "raw", "-expect", "string", "-o", "-", infoPlistPath]).trim() || undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
