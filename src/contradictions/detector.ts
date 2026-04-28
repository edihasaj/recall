/**
 * Contradiction detection — find conflicting memories.
 *
 * Detection strategies:
 *   1. Direct negation: "always X" vs "never X"
 *   2. Conflicting rules: "use A" vs "use B" for same scope
 *   3. Scope overlap: same rule at different scopes that conflict
 *   4. Superseded: newer memory supersedes older
 *
 * Automatically demotes the weaker side of detected contradictions.
 */

import { eq, and, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RecallDb } from "../db/client.js";
import { contradictions, memories } from "../db/schema.js";
import { queryMemories, demoteMemory, getMemory } from "../models/memory.js";
import { recordAudit } from "../audit/trail.js";
import type { Contradiction, MemoryItem } from "../types.js";

// --- Detect contradictions ---

export function detectContradictions(
  db: RecallDb,
  repo?: string,
): Contradiction[] {
  const mems = queryMemories(db, { repo }).filter(
    (m) => m.status === "active" || m.status === "candidate",
  );

  const found: Contradiction[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < mems.length; i++) {
    for (let j = i + 1; j < mems.length; j++) {
      const a = mems[i];
      const b = mems[j];
      const pairKey = [a.id, b.id].sort().join(":");
      if (seen.has(pairKey)) continue;

      const contradiction = checkContradiction(a, b);
      if (contradiction) {
        seen.add(pairKey);

        // Check if already recorded
        const existing = db
          .select()
          .from(contradictions)
          .where(
            and(
              eq(contradictions.memory_a_id, a.id),
              eq(contradictions.memory_b_id, b.id),
            ),
          )
          .get();

        if (!existing) {
          const id = randomUUID();
          const now = new Date().toISOString();

          db.insert(contradictions)
            .values({
              id,
              memory_a_id: a.id,
              memory_b_id: b.id,
              contradiction_type: contradiction.type,
              severity: contradiction.severity,
              description: contradiction.description,
              resolved: false,
              detected_at: now,
            })
            .run();

          recordAudit(db, a.id, "contradiction_detected", "system", contradiction.description);
          recordAudit(db, b.id, "contradiction_detected", "system", contradiction.description);

          found.push({
            id,
            memory_a_id: a.id,
            memory_b_id: b.id,
            contradiction_type: contradiction.type,
            severity: contradiction.severity,
            description: contradiction.description,
            resolved: false,
            resolution: null,
            detected_at: now,
            resolved_at: null,
          });
        }
      }
    }
  }

  return found;
}

// --- Check two memories for contradiction ---

export interface ContradictionMatch {
  type: Contradiction["contradiction_type"];
  severity: Contradiction["severity"];
  description: string;
}

export function checkContradiction(
  a: MemoryItem,
  b: MemoryItem,
): ContradictionMatch | null {
  // Only compare memories with overlapping scope
  if (!scopesOverlap(a, b)) return null;

  // 1. Direct negation: "always X" vs "never X"
  const negation = checkDirectNegation(a, b);
  if (negation) return negation;

  // 2. Conflicting rules: "use A" vs "use B"
  const conflict = checkConflictingRules(a, b);
  if (conflict) return conflict;

  // 3. Superseded check
  if (a.supersedes === b.id || b.supersedes === a.id) {
    return {
      type: "superseded",
      severity: "medium",
      description: `One memory supersedes the other`,
    };
  }

  return null;
}

// --- Direct negation detection ---

const NEGATION_PAIRS = [
  [/\balways\b/i, /\bnever\b/i],
  [/\bdo\b/i, /\bdo not\b|don't\b/i],
  [/\buse\b/i, /\bdo not use\b|don't use\b|never use\b/i],
  [/\brequired\b/i, /\bforbidden\b|prohibited\b/i],
  [/\benable\b/i, /\bdisable\b/i],
];

function checkDirectNegation(
  a: MemoryItem,
  b: MemoryItem,
): ContradictionMatch | null {
  // Extract the "subject" — the part after always/never/use/etc.
  for (const [pos, neg] of NEGATION_PAIRS) {
    const aPos = pos.test(a.text) && !neg.test(a.text);
    const aNeg = neg.test(a.text) && !pos.test(a.text);
    const bPos = pos.test(b.text) && !neg.test(b.text);
    const bNeg = neg.test(b.text) && !pos.test(b.text);

    if ((aPos && bNeg) || (aNeg && bPos)) {
      // Check if they're about the same subject
      const subjectA = extractSubject(a.text);
      const subjectB = extractSubject(b.text);
      if (subjectA && subjectB && wordOverlap(subjectA, subjectB) > 0.5) {
        return {
          type: "direct_negation",
          severity: "high",
          description: `"${a.text}" contradicts "${b.text}"`,
        };
      }
    }
  }

  return null;
}

// --- Conflicting rules detection ---

function checkConflictingRules(
  a: MemoryItem,
  b: MemoryItem,
): ContradictionMatch | null {
  // Both must be rules or commands
  if (a.type !== b.type) return null;
  if (a.type !== "rule" && a.type !== "command") return null;

  // "use X" vs "use Y" for the same context
  const useA = a.text.match(/\buse\s+(\S+)/i);
  const useB = b.text.match(/\buse\s+(\S+)/i);

  if (useA && useB) {
    const toolA = useA[1].toLowerCase().replace(/[,.:;]/g, "");
    const toolB = useB[1].toLowerCase().replace(/[,.:;]/g, "");

    if (toolA !== toolB) {
      // Check if they're about the same category
      const contextA = extractContext(a.text);
      const contextB = extractContext(b.text);
      if (contextA && contextB && wordOverlap(contextA, contextB) > 0.3) {
        return {
          type: "conflicting_rules",
          severity: "medium",
          description: `"use ${toolA}" vs "use ${toolB}" in similar context`,
        };
      }
    }
  }

  // High text similarity but different content → suspicious
  const sim = wordOverlap(a.text, b.text);
  if (sim > 0.6 && sim < 0.95 && a.text !== b.text) {
    // Very similar but not identical — might be conflicting versions
    return {
      type: "scope_overlap",
      severity: "low",
      description: `Very similar memories (${(sim * 100).toFixed(0)}% overlap): "${a.text.slice(0, 50)}" vs "${b.text.slice(0, 50)}"`,
    };
  }

  return null;
}

// --- Resolve contradiction ---

export function resolveContradiction(
  db: RecallDb,
  contradictionId: string,
  keepMemoryId: string,
  actor: string,
  resolution?: string,
): boolean {
  const row = db
    .select()
    .from(contradictions)
    .where(eq(contradictions.id, contradictionId))
    .get();
  if (!row) return false;

  const now = new Date().toISOString();
  const demoteId =
    row.memory_a_id === keepMemoryId ? row.memory_b_id : row.memory_a_id;

  // Demote the loser
  demoteMemory(db, demoteId, `contradiction resolved: keep ${keepMemoryId.slice(0, 8)}`);

  db.update(contradictions)
    .set({
      resolved: true,
      resolution: resolution ?? `Kept ${keepMemoryId.slice(0, 8)}, demoted ${demoteId.slice(0, 8)}`,
      resolved_at: now,
    })
    .where(eq(contradictions.id, contradictionId))
    .run();

  recordAudit(db, keepMemoryId, "contradiction_resolved", actor, resolution ?? null);
  recordAudit(db, demoteId, "contradiction_resolved", actor, `demoted in favor of ${keepMemoryId.slice(0, 8)}`);

  return true;
}

/** Auto-resolve: keep the one with higher confidence */
export function autoResolveContradictions(
  db: RecallDb,
  repo?: string,
): number {
  const unresolved = db
    .select()
    .from(contradictions)
    .where(eq(contradictions.resolved, false))
    .all();

  let resolved = 0;
  for (const c of unresolved) {
    const a = getMemory(db, c.memory_a_id);
    const b = getMemory(db, c.memory_b_id);
    if (!a || !b) continue;
    if (repo && a.repo !== repo && b.repo !== repo) continue;

    // Only auto-resolve high severity or if confidence gap is clear
    if (c.severity === "low") continue;
    if (Math.abs(a.confidence - b.confidence) < 0.15) continue;

    const keepId = a.confidence >= b.confidence ? a.id : b.id;
    resolveContradiction(db, c.id, keepId, "auto-resolver", "Auto-resolved: higher confidence wins");
    resolved++;
  }

  return resolved;
}

// --- List contradictions ---

export function listContradictions(
  db: RecallDb,
  options: { resolved?: boolean } = {},
): Array<typeof contradictions.$inferSelect> {
  if (options.resolved !== undefined) {
    return db
      .select()
      .from(contradictions)
      .where(eq(contradictions.resolved, options.resolved))
      .all();
  }
  return db.select().from(contradictions).all();
}

// --- Helpers ---

function scopesOverlap(a: MemoryItem, b: MemoryItem): boolean {
  // Global scope overlaps with everything (applies in every repo)
  if (a.scope === "global" || b.scope === "global") return true;
  // Team scope overlaps with everything
  if (a.scope === "team" || b.scope === "team") return true;

  // Repo scope overlaps if same repo
  if (a.scope === "repo" && b.scope === "repo") {
    return !a.repo || !b.repo || a.repo === b.repo;
  }

  // Path scope overlaps if paths share prefix
  if (a.scope === "path" && b.scope === "path") {
    if (!a.path_scope || !b.path_scope) return true;
    return (
      a.path_scope.startsWith(b.path_scope.replace("/**", "")) ||
      b.path_scope.startsWith(a.path_scope.replace("/**", ""))
    );
  }

  // Repo overlaps with path in same repo
  if (
    (a.scope === "repo" && b.scope === "path") ||
    (a.scope === "path" && b.scope === "repo")
  ) {
    return !a.repo || !b.repo || a.repo === b.repo;
  }

  return false;
}

function extractSubject(text: string): string {
  // Strip the "always/never/use/don't" prefix to get the subject
  return text
    .replace(/\b(always|never|must|do not|don't|use|do|run|call|import)\b/gi, "")
    .trim()
    .toLowerCase();
}

function extractContext(text: string): string {
  // Strip the "use X" part to get surrounding context
  return text
    .replace(/\buse\s+\S+/i, "")
    .trim()
    .toLowerCase();
}

function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const intersection = [...wordsA].filter((w) => wordsB.has(w));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.length / union.size;
}
