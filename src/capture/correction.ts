import type { RecallDb } from "../db/client.js";
import { createMemory, queryMemories, promoteMemory } from "../models/memory.js";
import type { CreateMemoryInput } from "../models/memory.js";
import type { MemoryType, EvidenceEntry } from "../types.js";

// --- Detection patterns ---

interface CorrectionMatch {
  type: MemoryType;
  text: string;
  confidence: number;
  original?: string;
}

const NEGATION_REPLACEMENT =
  /\b(?:not|don't|do not|never|stop)\s+(?:use|do|run|call|import)\s+(.+?)[\s,;.]+(?:use|do|run|call|import|instead)\s+(.+)/i;

const EXPLICIT_RULE =
  /\b(always|never|must|required|forbidden|don't ever)\b\s+(.+)/i;

const REVIEW_FEEDBACK =
  /\b(?:review|reviewer|PR feedback|code review)\s+(?:said|says|asked|wants|requires|flagged)\s+(.+)/i;

const PREFERENCE =
  /\b(?:we|I|the team)\s+(?:prefer|use|always use|always do|want)\s+(.+?)(?:\s+(?:instead of|not|over)\s+(.+))?$/i;

export function detectCorrections(text: string): CorrectionMatch[] {
  const matches: CorrectionMatch[] = [];

  // Negation + replacement: "don't use X, use Y"
  const negMatch = text.match(NEGATION_REPLACEMENT);
  if (negMatch) {
    matches.push({
      type: "rule",
      text: `Do not use ${negMatch[1].trim()}. Use ${negMatch[2].trim()} instead.`,
      confidence: 0.45,
      original: text,
    });
  }

  // Review feedback: "review said to do X" (check before explicit rule to avoid dupes)
  const reviewMatch = text.match(REVIEW_FEEDBACK);
  if (reviewMatch) {
    matches.push({
      type: "review_pattern",
      text: reviewMatch[1].trim(),
      confidence: 0.55, // stronger — review feedback
    });
  }

  // Explicit rule: "always do X" / "never do Y"
  const ruleMatch = text.match(EXPLICIT_RULE);
  if (ruleMatch && !negMatch && !reviewMatch) {
    matches.push({
      type: "rule",
      text: `${ruleMatch[1]} ${ruleMatch[2].trim()}`,
      confidence: 0.5,
    });
  }

  // Preference: "we prefer X over Y"
  const prefMatch = text.match(PREFERENCE);
  if (prefMatch && !negMatch && !ruleMatch) {
    const pref = prefMatch[2]
      ? `Prefer ${prefMatch[1].trim()} over ${prefMatch[2].trim()}`
      : `Prefer ${prefMatch[1].trim()}`;
    matches.push({
      type: "rule",
      text: pref,
      confidence: 0.4,
    });
  }

  return matches;
}

// --- Process correction into memory ---

export interface CorrectionContext {
  sessionId: string;
  repo?: string;
  path?: string;
}

export function processCorrection(
  db: RecallDb,
  text: string,
  ctx: CorrectionContext,
): string[] {
  const corrections = detectCorrections(text);
  if (corrections.length === 0) return [];

  const ids: string[] = [];

  for (const correction of corrections) {
    // Check if similar memory already exists (dedup by text similarity)
    const existing = queryMemories(db, {
      repo: ctx.repo,
      status: "candidate",
    });

    const duplicate = existing.find(
      (m) => textSimilarity(m.text, correction.text) > 0.8,
    );

    if (duplicate) {
      // Repeated correction → promote
      promoteMemory(db, duplicate.id, "repeat_correction", {
        type: "session_correction",
        session: ctx.sessionId,
        timestamp: new Date().toISOString(),
        context: text,
      });
      ids.push(duplicate.id);
      continue;
    }

    // New candidate
    const evidence: EvidenceEntry = correction.type === "review_pattern"
      ? {
          type: "review_feedback",
          reported_by_user: true,
          timestamp: new Date().toISOString(),
          context: text,
        }
      : {
          type: "session_correction",
          session: ctx.sessionId,
          timestamp: new Date().toISOString(),
          context: text,
        };

    const input: CreateMemoryInput = {
      type: correction.type,
      text: correction.text,
      scope: ctx.path ? "path" : "repo",
      path_scope: ctx.path ?? null,
      repo: ctx.repo ?? null,
      source:
        correction.type === "review_pattern"
          ? "user_reported_review"
          : "user_correction",
      confidence: correction.confidence,
      evidence: [evidence],
    };

    const id = createMemory(db, input);
    ids.push(id);
  }

  return ids;
}

// --- Report review feedback ---

export function processReviewFeedback(
  db: RecallDb,
  feedback: string,
  ctx: CorrectionContext & { reviewer?: string },
): string[] {
  const evidence: EvidenceEntry = {
    type: "review_feedback",
    reported_by_user: true,
    reviewer: ctx.reviewer,
    timestamp: new Date().toISOString(),
    context: feedback,
  };

  // Try to detect structured corrections from the feedback
  const corrections = detectCorrections(feedback);

  if (corrections.length > 0) {
    const ids: string[] = [];
    for (const correction of corrections) {
      const id = createMemory(db, {
        type: correction.type,
        text: correction.text,
        scope: ctx.path ? "path" : "repo",
        path_scope: ctx.path ?? null,
        repo: ctx.repo ?? null,
        source: "user_reported_review",
        confidence: correction.confidence + 0.1, // review feedback bonus
        evidence: [evidence],
      });
      ids.push(id);
    }
    return ids;
  }

  // Unstructured — store as-is with lower confidence
  const id = createMemory(db, {
    type: "review_pattern",
    text: feedback,
    scope: ctx.path ? "path" : "repo",
    path_scope: ctx.path ?? null,
    repo: ctx.repo ?? null,
    source: "user_reported_review",
    confidence: 0.4,
    evidence: [evidence],
  });

  return [id];
}

// --- Text similarity (simple word overlap) ---

function textSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...wordsA].filter((w) => wordsB.has(w));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.length / union.size; // Jaccard similarity
}
