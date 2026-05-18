/**
 * Canonical-form helpers for entity dedup. Two entities with the same
 * (kind, normalizedName, repo) collapse into one node.
 *
 * Normalization rules are conservative on purpose — we'd rather have a
 * duplicate than merge two semantically distinct things. Aggressive
 * merging belongs in a maintenance pass that can be reviewed.
 */

export type EntityKind =
  | "file"
  | "function"
  | "library"
  | "tool"
  | "concept"
  | "repo_path"
  | "command"
  | "url";

export function normalizeName(kind: EntityKind, raw: string): string {
  const trimmed = raw.trim();
  switch (kind) {
    case "file":
    case "repo_path":
      // Posix-style paths, no leading slash, no trailing slash.
      return trimmed
        .replace(/\\/g, "/")
        .replace(/^[./]+/, "")
        .replace(/\/+$/, "")
        .toLowerCase();
    case "function":
      // foo() / Class.method / obj.method — keep the dotted form, drop parens/args.
      return trimmed
        .replace(/\(.*\)/, "")
        .replace(/\s+/g, "")
        .toLowerCase();
    case "library":
    case "tool":
    case "command":
      // package names / CLI names: lowercase, strip @scope leading-only if present
      // but keep `@scope/name` distinct from `name`.
      return trimmed.toLowerCase();
    case "url":
      try {
        const u = new URL(trimmed);
        return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
      } catch {
        return trimmed.toLowerCase();
      }
    case "concept":
    default:
      return trimmed.toLowerCase().replace(/\s+/g, " ");
  }
}

export function isPlausibleEntityName(kind: EntityKind, name: string): boolean {
  const n = name.trim();
  if (n.length === 0 || n.length > 200) return false;
  // Filter common false positives that look like identifiers but aren't.
  if (/^[0-9]+$/.test(n)) return false;
  if (kind === "concept" && n.split(/\s+/).length > 8) return false;
  // Single-letter "library" tokens are almost always noise.
  if ((kind === "library" || kind === "tool") && n.length < 2) return false;
  return true;
}
