import type { RecallDb } from "../db/client.js";
import { findSemanticDuplicates, loadEmbeddingConfigFromEnv } from "../embeddings/embeddings.js";
import {
  appendEvidence,
  countDistinctCorrectionSessions,
  createMemory,
  getMemory,
  getMemoryFeedback,
  incrementMemoryRepetition,
  promoteMemory,
  queryMemories,
  updateMemoryCaptureContext,
} from "../models/memory.js";
import type { CreateMemoryInput } from "../models/memory.js";
import type { CaptureContext, MemoryItem, MemoryType, EvidenceEntry } from "../types.js";
import { getRepoQualityProfile, seedCandidateConfidence } from "../repo/quality.js";
import { inferScope } from "./scope.js";
import type { RecentToolCall } from "../agents/types.js";
import { recordAuditWithSnapshot } from "../audit/trail.js";

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

const SOFT_PREFERENCE =
  /\b(?:we|I|the team|this repo)\s+(?:prefer|usually use|tend to use|lean on|default to|use)\s+(.+?)(?:\s+(?:instead of|not|over)\s+(.+))?$/i;

const SOFT_DECISION =
  /\b(?:let's|lets|let us|we should|we'll|we will|we can|use)\s+(?:use|keep|follow|stick with|go with)\s+(.+?)(?:\s+(?:instead of|over)\s+(.+))?(?:[.!]|$)/i;

const CONFIG_BACKED_DECISION =
  /\b(?:editorconfig|prettier|eslint|tsconfig|package\.json|ci|workflow|this repo)\b.*\b(?:says|uses|wants|defaults to|is configured for)\s+(.+)/i;

const QUESTION_ONLY =
  /^\s*(?:should|could|would|can|do)\b.*\?\s*$/i;

export function detectCorrections(text: string): CorrectionMatch[] {
  const normalizedText = text.trim();
  if (QUESTION_ONLY.test(normalizedText)) return [];

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
  const decisionMatch = text.match(SOFT_DECISION);
  if (decisionMatch && !negMatch && !ruleMatch && !reviewMatch) {
    const decision = decisionMatch[2]
      ? `Prefer ${decisionMatch[1].trim()} over ${decisionMatch[2].trim()}`
      : `Use ${stripTrailingPunctuation(decisionMatch[1])}`;
    matches.push({
      type: "decision",
      text: ensureSentence(decision),
      confidence: 0.38,
    });
  }

  const prefMatch = text.match(SOFT_PREFERENCE);
  if (prefMatch && !negMatch && !ruleMatch && !reviewMatch && !decisionMatch) {
    const pref = prefMatch[2]
      ? `Prefer ${prefMatch[1].trim()} over ${prefMatch[2].trim()}`
      : `Prefer ${stripTrailingPunctuation(prefMatch[1])}`;
    matches.push({
      type: "decision",
      text: ensureSentence(pref),
      confidence: 0.36,
    });
  }

  const configMatch = text.match(CONFIG_BACKED_DECISION);
  if (configMatch && !negMatch && !ruleMatch && !reviewMatch && !decisionMatch) {
    matches.push({
      type: "decision",
      text: ensureSentence(`Follow configured repo convention: ${stripTrailingPunctuation(configMatch[1])}`),
      confidence: 0.42,
    });
  }

  return matches;
}

// --- Process correction into memory ---

export interface CorrectionContext {
  sessionId: string;
  repo?: string;
  path?: string;
  agent?: string;
  prev_assistant_turn?: string;
  recent_tool_calls?: readonly RecentToolCall[];
}

function stripTrailingPunctuation(text: string): string {
  return text.trim().replace(/[.?!,:;]+$/, "");
}

function ensureSentence(text: string): string {
  const cleaned = stripTrailingPunctuation(text);
  return cleaned.endsWith(".") ? cleaned : `${cleaned}.`;
}

export async function processCorrection(
  db: RecallDb,
  text: string,
  ctx: CorrectionContext,
): Promise<string[]> {
  const corrections = detectCorrections(text);
  if (corrections.length === 0) return [];
  const profile = getRepoQualityProfile(db, ctx.repo);

  const ids: string[] = [];
  const captureContext = buildCaptureContext(ctx);

  for (const correction of corrections) {
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

    const duplicate = await findDuplicateMemory(
      db,
      ctx.repo,
      correction.type,
      correction.text,
      profile.dedup_similarity_threshold,
    );

    if (duplicate) {
      const before = getMemory(db, duplicate.id);
      appendEvidence(db, duplicate.id, evidence);
      if (captureContext) {
        updateMemoryCaptureContext(db, duplicate.id, captureContext);
      }
      if (before && !before.evidence.some((entry) => entry.type === "session_correction" && entry.session === ctx.sessionId)) {
        incrementMemoryRepetition(db, duplicate.id);
      }
      const updated = getMemory(db, duplicate.id);

      if (
        updated &&
        updated.status !== "active" &&
        countDistinctCorrectionSessions(updated) >= profile.repeat_sessions_required
      ) {
        promoteMemory(db, duplicate.id, "repeat_correction");
        const after = getMemory(db, duplicate.id);
        recordAuditWithSnapshot(
          db,
          duplicate.id,
          "promoted",
          "system",
          `repetition:${after?.repetition_count ?? updated.repetition_count}`,
          before ?? null,
          after ?? null,
        );
      }

      ids.push(duplicate.id);
      continue;
    }

    // New candidate
    const inferredScope = inferScope(
      correction.text,
      ctx.path,
      undefined,
      {
        prev_assistant_turn: ctx.prev_assistant_turn,
        recent_tool_calls: ctx.recent_tool_calls,
      },
    );
    const input: CreateMemoryInput = {
      type: correction.type,
      text: correction.text,
      scope: inferredScope.scope,
      path_scope: inferredScope.path_scope,
      repo: ctx.repo ?? null,
      source:
        correction.type === "review_pattern"
          ? "user_reported_review"
          : "user_correction",
      confidence: seedCandidateConfidence(
        Math.min(1, correction.confidence + inferredScope.confidence_modifier),
        profile,
      ),
      evidence: [evidence],
      capture_context: captureContext,
    };

    const id = createMemory(db, input);
    maybePromoteGroupCandidate(db, id);
    ids.push(id);
  }

  return ids;
}

function maybePromoteGroupCandidate(
  db: RecallDb,
  candidateId: string,
) {
  const candidate = getMemory(db, candidateId);
  if (!candidate || candidate.status !== "candidate") return;

  const followedCount = queryMemories(db, {
    repo: candidate.repo ?? undefined,
    type: candidate.type,
    scope: candidate.scope,
  })
    .filter((memory) => memory.id !== candidate.id)
    .reduce((total, memory) => (
      total + getMemoryFeedback(db, memory.id).filter((entry) => entry.outcome === "followed").length
    ), 0);

  if (followedCount < 3) return;

  const before = candidate;
  promoteMemory(db, candidate.id, "repeat_correction");
  const after = getMemory(db, candidate.id);
  recordAuditWithSnapshot(
    db,
    candidate.id,
    "promoted",
    "system",
    `repetition:group_followed:${followedCount}`,
    before,
    after ?? null,
  );
}

function buildCaptureContext(ctx: CorrectionContext): CaptureContext | null {
  const recentToolCalls = (ctx.recent_tool_calls ?? [])
    .slice(-5)
    .map((toolCall) => ({
      name: toolCall.name,
      path: toolCall.path ?? extractContextPath(toolCall.input_summary),
      exit_code: toolCall.exit_code,
    }));

  const hasContext =
    Boolean(ctx.prev_assistant_turn) ||
    recentToolCalls.length > 0 ||
    Boolean(ctx.repo) ||
    Boolean(ctx.path) ||
    Boolean(ctx.agent);

  if (!hasContext) return null;

  return {
    prev_assistant_text: ctx.prev_assistant_turn,
    recent_tool_calls: recentToolCalls,
    repo: ctx.repo ?? null,
    path: ctx.path ?? null,
    agent: ctx.agent,
  };
}

function extractContextPath(text?: string): string | undefined {
  if (!text) return undefined;
  const match = text.match(
    /\b((?:src|lib|app|components|utils|test|spec)\/[\w./-]+|[\w./-]+\.(?:ts|tsx|js|jsx|py|rs|go|swift|java|rb|json|toml|ya?ml))\b/,
  );
  return match?.[1];
}

// --- Report review feedback ---

export async function processReviewFeedback(
  db: RecallDb,
  feedback: string,
  ctx: CorrectionContext & { reviewer?: string },
): Promise<string[]> {
  const profile = getRepoQualityProfile(db, ctx.repo);
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
      const duplicate = await findDuplicateMemory(
        db,
        ctx.repo,
        correction.type,
        correction.text,
        profile.dedup_similarity_threshold,
      );

      if (duplicate) {
        appendEvidence(db, duplicate.id, evidence);
        const updated = getMemory(db, duplicate.id);
        if (
          updated &&
          updated.status !== "active" &&
          countDistinctCorrectionSessions(updated) >= Math.max(1, profile.repeat_sessions_required - 1)
        ) {
          promoteMemory(db, duplicate.id, "review_feedback");
        }
        ids.push(duplicate.id);
        continue;
      }

      const id = createMemory(db, {
        type: correction.type,
        text: correction.text,
        scope: ctx.path ? "path" : "repo",
        path_scope: ctx.path ?? null,
        repo: ctx.repo ?? null,
        source: "user_reported_review",
        confidence: seedCandidateConfidence(correction.confidence + 0.1, profile),
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
    confidence: seedCandidateConfidence(0.4, profile),
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

async function findDuplicateMemory(
  db: RecallDb,
  repo: string | undefined,
  type: MemoryType,
  text: string,
  threshold: number,
): Promise<MemoryItem | undefined> {
  if (!repo) return undefined;

  const existing = queryMemories(db, { repo })
    .filter((m) => m.status !== "rejected" && m.type === type);

  let best: MemoryItem | undefined;
  let bestScore = 0;

  for (const memory of existing) {
    const score = textSimilarity(memory.text, text);
    if (score >= threshold && score > bestScore) {
      best = memory;
      bestScore = score;
    }
  }

  if (best) return best;

  const config = loadEmbeddingConfigFromEnv();
  if (!config) return undefined;

  const semantic = await findSemanticDuplicates(
    db,
    text,
    config,
    threshold,
    { repo, type, limit: 1 },
  );

  return semantic[0] ? getMemory(db, semantic[0].id) : undefined;
}
