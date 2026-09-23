/**
 * Supersession — a newer fact retires the older facts it replaces.
 *
 * "Use pnpm" arriving after "Use npm as the package manager" should not leave
 * both active and let confidence pick a winner. The newer statement wins, and
 * memories that merely *use* the retired tool ("run `npm run migrate`") lose
 * their standing too, because they were written for a world that no longer
 * exists. That second step is the ripple.
 *
 * Detection is deliberately narrow: only tool families where exactly one member
 * can be the answer for a repo (JS package managers, Python package managers).
 * A false supersession silently deletes a good memory, so every rule here must
 * be one a person would agree with on sight. Everything else stays with the
 * pairwise contradiction detector.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { memories } from "../db/schema.js";
import { demoteMemory, getMemory, queryMemories, rejectMemory } from "../models/memory.js";
import { recordAudit, recordAuditWithSnapshot } from "../audit/trail.js";
import { queueMemoryEmbeddingSync } from "../embeddings/embeddings.js";
import type { MemoryItem } from "../types.js";

// Tokens are matched case-sensitively: tool names are written in lower case,
// and "PiP" (picture-in-picture) must not read as pip.
export const TOOL_FAMILIES: Record<string, Record<string, string[]>> = {
  js_package_manager: {
    npm: ["npm", "npx"],
    pnpm: ["pnpm"],
    yarn: ["yarn"],
    bun: ["bun", "bunx"],
  },
  python_package_manager: {
    pip: ["pip", "pip3"],
    uv: ["uv", "uvx"],
    poetry: ["poetry"],
    pipenv: ["pipenv"],
  },
};

export interface FamilyStance {
  prefers: Set<string>;
  forbids: Set<string>;
  mentions: Set<string>;
  /** Chosen only for a narrow purpose; never wins or loses a supersession. */
  scoped: Set<string>;
}

const BOUNDARY_BEFORE = "(?<![\\w./@-])";
const BOUNDARY_AFTER = "(?![\\w-])";
const QUOTE = "[`'\"]?";
const PREFER_VERBS =
  "(?:use|uses|using|prefer|prefers|switch(?:ed)? to|migrate(?:d)? to|moved to|standardi[sz]e on)";
const FORBID_LEADS =
  "(?:never|don't|do not|avoid|stop|no longer)\\s+(?:use|using|run|running|call|calling)?\\s*";
// Covers lists: "uv instead of pip or poetry" retires both.
const REPLACE_LEADS =
  "(?:instead of|rather than|over|not)\\s+(?:[`'\"]?[\\w.-]+[`'\"]?\\s*(?:,|/|\\bor\\b|\\band\\b)\\s*){0,3}";

function tokenRegex(token: string): string {
  return `${BOUNDARY_BEFORE}${QUOTE}${token}${QUOTE}${BOUNDARY_AFTER}`;
}

// "use `npm run build`" names a command, not a package-manager choice.
const SUBCOMMAND =
  /^\s*(?:run|install|i|add|ci|exec|test|build|dlx|x|publish|remove|rm|update|up|upgrade|sync|lint|start|dev|audit|link|pack|init|create|pip|-{1,2}\w)\b/i;
// A choice qualified with a narrow purpose ("use pnpm for e2e verification")
// says nothing about the repo's package manager, so it neither wins nor loses.
const QUALIFIER = /^\s*[`'"]?\s*(?:for|when|in|on|during|with)\s+([^.;\n]+)/i;
const GENERAL_QUALIFIER =
  /\b(?:package|dependenc|install|this (?:repo|repository|project)|the (?:repo|repository|project)|all\b|every|monorepo|workspace|python|node|javascript|js\b|typescript|tooling|backend|frontend)/i;

function insideCommandSpan(text: string, index: number): boolean {
  for (const span of text.matchAll(/`([^`]*)`/g)) {
    const start = span.index ?? 0;
    const end = start + span[0].length;
    if (index > start && index < end && /\s/.test(span[1].trim())) return true;
  }
  return false;
}

/** How a memory's text relates to each tool in one family. */
export function familyStance(text: string, family: Record<string, string[]>): FamilyStance {
  const stance: FamilyStance = { prefers: new Set(), forbids: new Set(), mentions: new Set(), scoped: new Set() };
  for (const [tool, tokens] of Object.entries(family)) {
    for (const token of tokens) {
      const tok = tokenRegex(token);
      if (!new RegExp(tok).test(text)) continue;
      stance.mentions.add(tool);
      const forbid = new RegExp(`\\b${FORBID_LEADS}${tok}`, "i");
      const replaced = new RegExp(`\\b${REPLACE_LEADS}${tok}`, "i");
      if (forbid.test(text) || replaced.test(text)) {
        stance.forbids.add(tool);
        continue;
      }
      const verb = new RegExp(`\\b${PREFER_VERBS}\\s+(?:the\\s+)?${tok}`, "gi");
      const lead = new RegExp(`(?:^|[.;:!?]\\s*)${tok}\\s+(?:only|instead of|rather than|over|not)\\b`, "i");
      for (const match of text.matchAll(verb)) {
        const at = (match.index ?? 0) + match[0].length;
        if (insideCommandSpan(text, at - 1)) continue;
        const tail = text.slice(at);
        if (SUBCOMMAND.test(tail)) continue;
        const qualifier = tail.match(QUALIFIER);
        if (qualifier && !GENERAL_QUALIFIER.test(qualifier[1])) {
          stance.scoped.add(tool);
          continue;
        }
        stance.prefers.add(tool);
      }
      if (lead.test(text)) stance.prefers.add(tool);
    }
  }
  for (const tool of stance.forbids) stance.prefers.delete(tool);
  return stance;
}

/** The single tool a memory chooses in this family, or null when it chooses none or several. */
function preferred(stance: FamilyStance): string | null {
  return stance.prefers.size === 1 ? [...stance.prefers][0] : null;
}

const HUMAN_SOURCES = new Set(["user_correction", "user_reported_review"]);
const LIVE = ["active", "candidate"] as const;

function scopeCovers(newer: MemoryItem, older: MemoryItem): boolean {
  const broad = (s: string) => s === "global" || s === "team";
  if (broad(newer.scope)) return broad(older.scope);
  if (broad(older.scope)) return false;
  if (newer.repo && older.repo && newer.repo !== older.repo) return false;
  if (newer.scope === "repo") return older.scope === "repo" || older.scope === "path";
  if (newer.scope === "path") {
    if (older.scope !== "path") return false;
    const root = (newer.path_scope ?? "").replace(/\/?\*\*$/, "");
    return !root || (older.path_scope ?? "").startsWith(root);
  }
  return false;
}

export type SupersessionAction = "superseded" | "rippled";

export interface SupersessionChange {
  memory_id: string;
  action: SupersessionAction;
  family: string;
  reason: string;
}

/**
 * Compare two memories in one family. Returns what should happen to `older`
 * when `newer` is the most recent statement, or null when they are compatible.
 */
export function supersessionVerdict(
  newer: Pick<MemoryItem, "text">,
  older: Pick<MemoryItem, "text">,
  rippleAllowed = true,
): { action: SupersessionAction; family: string; reason: string } | null {
  for (const [familyName, family] of Object.entries(TOOL_FAMILIES)) {
    const n = familyStance(newer.text, family);
    const chosen = preferred(n);
    const retired = new Set(n.forbids);
    if (!chosen && retired.size === 0) continue;

    const o = familyStance(older.text, family);
    if (o.mentions.size === 0) continue;

    const olderChoice = preferred(o);
    const conflictsWithChoice = chosen
      && ((olderChoice && olderChoice !== chosen) || o.forbids.has(chosen));
    const choosesRetired = olderChoice && retired.has(olderChoice);
    if (conflictsWithChoice || choosesRetired) {
      return {
        action: "superseded",
        family: familyName,
        reason: `superseded by newer ${familyName} choice: ${chosen ?? `not ${[...retired].join("/")}`}`,
      };
    }

    // Ripple: the older memory states no choice of its own but is written
    // around a tool the newer memory retires. Mixed memories that mention the
    // chosen tool too ("pnpm for web, npm for the API") are left alone. Only a
    // person's statement ripples; a lockfile can't say which written rules
    // were meant for a subdirectory it doesn't see.
    if (!rippleAllowed) continue;
    if (olderChoice || o.prefers.size > 0 || o.forbids.size > 0 || o.scoped.size > 0) continue;
    const stale = [...o.mentions].filter((tool) =>
      chosen ? tool !== chosen : retired.has(tool),
    );
    if (stale.length === o.mentions.size && stale.length > 0 && (!chosen || !o.mentions.has(chosen))) {
      return {
        action: "rippled",
        family: familyName,
        reason: `depends on ${stale.join("/")}, which a newer ${familyName} choice retired`,
      };
    }
  }
  return null;
}

/**
 * Apply supersession for a newly written or restated memory. Older conflicting
 * choices are rejected; memories built on the retired tool are demoted to
 * candidates so they stop being injected until confirmed or rewritten. Every
 * change is audited with a snapshot, so `recall rollback` can undo it.
 */
export function applySupersession(db: RecallDb, newerId: string): SupersessionChange[] {
  const newer = getMemory(db, newerId);
  if (!newer || !LIVE.includes(newer.status as (typeof LIVE)[number])) return [];

  const newerIsHuman = HUMAN_SOURCES.has(newer.source);
  const broad = newer.scope === "global" || newer.scope === "team";
  const pool = (broad
    ? [...queryMemories(db, { scope: "global" }), ...queryMemories(db, { scope: "team" })]
    : newer.repo ? queryMemories(db, { repo: newer.repo }) : [])
    .filter((m) => m.id !== newer.id && LIVE.includes(m.status as (typeof LIVE)[number]));
  const seen = new Set<string>();
  const changes: SupersessionChange[] = [];

  for (const older of pool) {
    if (seen.has(older.id)) continue;
    seen.add(older.id);
    if (older.created_at > newer.created_at && older.updated_at > newer.updated_at) continue;
    if (!scopeCovers(newer, older)) continue;
    // Repo scans observe files; people state intent. A scan only replaces an
    // earlier derived fact ("Use npm as the package manager"), never what a
    // person said or wrote into AGENTS.md, e.g. "use pnpm" before the lockfile
    // has moved.
    if (!newerIsHuman && older.source !== "config_parse") continue;

    const verdict = supersessionVerdict(newer, older, newerIsHuman);
    if (!verdict) continue;

    const reason = `${verdict.reason} (by ${newer.id.slice(0, 8)}: "${newer.text.slice(0, 120)}")`;
    if (verdict.action === "superseded") {
      // rejectMemory writes the snapshot audit row; add the why alongside it.
      rejectMemory(db, older.id, "supersession");
      recordAudit(db, older.id, "contradiction_resolved", "supersession", reason);
    } else {
      if (older.status !== "active") continue;
      const before = getMemory(db, older.id);
      demoteMemory(db, older.id, verdict.reason);
      recordAuditWithSnapshot(db, older.id, "demoted", "supersession", reason, before ?? null, getMemory(db, older.id) ?? null);
    }
    changes.push({ memory_id: older.id, ...verdict });
  }

  const firstSuperseded = changes.find((c) => c.action === "superseded");
  if (firstSuperseded && !newer.supersedes) {
    db.update(memories)
      .set({ supersedes: firstSuperseded.memory_id })
      .where(and(eq(memories.id, newer.id), inArray(memories.status, [...LIVE])))
      .run();
    queueMemoryEmbeddingSync(db, newer.id);
  }
  return changes;
}
