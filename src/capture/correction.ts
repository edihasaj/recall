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
import { qualityReasons } from "../maintenance/cleanup.js";

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

// "whenever / each time / every time / when I (say|use|ask|mention) X, do Y"
// captures meta-rules that don't start with always/never. The trigger (X) and
// the action (Y) are stored together as a single rule sentence.
const WHEN_DO_RULE =
  /\b(?:whenever|each time|every time|when(?:ever)?)\s+(?:i|you|we)\s+(say|use|ask|mention|do|run)\s+(.+?)[,.]?\s+(?:we|you|i|please|always|just)?\s*(do|run|use|please|add|make|update|commit|push|backup|back up|sync|verify|check|ensure)\s+(.+)/i;

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

// Modals preceded within 3 tokens by a pronoun/relative pronoun are
// descriptive, not prescriptive: "things I never use", "stuff we always do",
// "those plugins I never use from settings". The substring after the modal
// looks rule-shaped to EXPLICIT_RULE but the surrounding clause makes it
// narration. Skip the whole segment.
const DESCRIPTIVE_MODAL_RE =
  /\b(?:i|you|we|they|those|that|which|who)(?:\s+\w+){0,2}\s+(?:always|never|must|don't|do not|prefer|required|forbidden)\b/i;

// A captured rule is "destructive-risky" when it pairs a destructive verb with
// a high-risk target (settings, plugins, files, memories, secrets, history,
// branches, etc.). Even with strong repetition signal, these rules require an
// explicit `recall confirm` before they go active — otherwise an agent could
// follow them and irreversibly damage user state.
const DESTRUCTIVE_VERB_RE =
  /\b(?:remove|delete|drop|wipe|clear|purge|erase|nuke|truncate|reset|destroy)\b/i;
const HIGH_RISK_TARGET_RE =
  /\b(?:plugin|plugins|setting|settings|config|configs|configuration|file|files|folder|folders|directory|directories|memor(?:y|ies)|database|db|repo|repos|repository|branch|branches|commit|commits|history|backup|backups|secret|secrets|credential|credentials|key|keys|token|tokens)\b/i;

export function isDestructiveRisky(text: string): boolean {
  return DESTRUCTIVE_VERB_RE.test(text) && HIGH_RISK_TARGET_RE.test(text);
}

export function detectCorrections(text: string): CorrectionMatch[] {
  const normalizedText = text.trim();
  if (QUESTION_ONLY.test(normalizedText)) return [];
  if (looksLikePastedTranscript(normalizedText)) return [];

  const matches: CorrectionMatch[] = [];
  const segments = correctionCandidateSegments(normalizedText);

  for (const segment of segments) {
    // Drop segments where the modal is part of a descriptive clause
    // ("remove those plugins I never use") rather than an instruction
    // ("we prefer X"). Heuristic: if the pronoun-modal pattern is preceded
    // by other words in the segment, it's narration about an object; if it's
    // at the start, it's a direct statement and we keep it.
    const descriptive = DESCRIPTIVE_MODAL_RE.exec(segment);
    if (descriptive && descriptive.index > 0) continue;

    // Trigger → action: "whenever I say X, do Y"
    const whenDo = segment.match(WHEN_DO_RULE);
    if (whenDo) {
      const trigger = stripTrailingPunctuation(whenDo[2]);
      const action = stripTrailingPunctuation(`${whenDo[3]} ${whenDo[4]}`);
      matches.push({
        type: "rule",
        text: `When user ${whenDo[1].toLowerCase()}s "${trigger}", ${action}.`,
        confidence: 0.5,
        original: segment,
      });
      continue;
    }

    // Negation + replacement: "don't use X, use Y"
    const negMatch = segment.match(NEGATION_REPLACEMENT);
    if (negMatch) {
      matches.push({
        type: "rule",
        text: `Do not use ${negMatch[1].trim()}. Use ${negMatch[2].trim()} instead.`,
        confidence: 0.45,
        original: segment,
      });
      continue;
    }

    // Review feedback: "review said to do X" (check before explicit rule to avoid dupes)
    const reviewMatch = segment.match(REVIEW_FEEDBACK);
    if (reviewMatch) {
      matches.push({
        type: "review_pattern",
        text: reviewMatch[1].trim(),
        confidence: 0.55, // stronger — review feedback
      });
      continue;
    }

    // Explicit rule: "always do X" / "never do Y"
    const ruleMatch = segment.match(EXPLICIT_RULE);
    if (ruleMatch) {
      matches.push({
        type: "rule",
        text: `${ruleMatch[1]} ${ruleMatch[2].trim()}`,
        confidence: 0.5,
      });
      continue;
    }

    // Preference: "we prefer X over Y"
    const decisionMatch = segment.match(SOFT_DECISION);
    if (decisionMatch && isDurableDecision(segment, decisionMatch[1], decisionMatch[2])) {
      const decision = decisionMatch[2]
        ? `Prefer ${decisionMatch[1].trim()} over ${decisionMatch[2].trim()}`
        : `Use ${stripTrailingPunctuation(decisionMatch[1])}`;
      matches.push({
        type: "decision",
        text: ensureSentence(decision),
        confidence: 0.38,
      });
      continue;
    }

    const prefMatch = segment.match(SOFT_PREFERENCE);
    if (prefMatch && isDurableDecision(segment, prefMatch[1], prefMatch[2])) {
      const pref = prefMatch[2]
        ? `Prefer ${prefMatch[1].trim()} over ${prefMatch[2].trim()}`
        : `Prefer ${stripTrailingPunctuation(prefMatch[1])}`;
      matches.push({
        type: "decision",
        text: ensureSentence(pref),
        confidence: 0.36,
      });
      continue;
    }

    const configMatch = segment.match(CONFIG_BACKED_DECISION);
    if (configMatch) {
      matches.push({
        type: "decision",
        text: ensureSentence(`Follow configured repo convention: ${stripTrailingPunctuation(configMatch[1])}`),
        confidence: 0.42,
      });
    }
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

const TRANSCRIPT_MARKERS = [
  "※ recap:",
  "✻",
  "⏺",
  "⎿",
  "❯",
  "Bash(",
  "Hook activity",
  "Top reused memories",
  "RECENT INJECTIONS",
  "BREAKDOWN BY TYPE",
  "sqlite3",
];

const DURABLE_DECISION_HINT =
  /\b(repo|repository|project|default|defaults|convention(?:al|s)?|configured|config|editorconfig|prettier|eslint|tsconfig|package\.json|ci|workflow|style|pattern|architecture|runtime|database|sqlite|pnpm|yarn|npm|uv|pytest|vitest)\b/i;

const TRANSCRIPT_LINE_RE =
  /^(?:[⏺⎿❯✻※]|(?:Bash|Edit|Write|Read|Grep|Glob|Task|TodoWrite)\(|\s*(?:│|├|┌|└|─)|\s*…|\s*={3,})/u;

function looksLikePastedTranscript(text: string): boolean {
  if (text.length < 1_200) return false;
  const markerCount = TRANSCRIPT_MARKERS.reduce(
    (total, marker) => total + (text.includes(marker) ? 1 : 0),
    0,
  );
  return markerCount >= 2;
}

function correctionCandidateSegments(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const singleLine = lines.length === 1;
  const segments = singleLine
    ? [text]
    : lines.map((line) => line.trim()).filter(Boolean);

  return segments
    .map(stripListPrefix)
    .filter((line) => line.length >= 8 && line.length <= 500)
    .filter((line) => !TRANSCRIPT_LINE_RE.test(line))
    .filter((line) => !line.startsWith("```"));
}

function stripListPrefix(text: string): string {
  return text.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim();
}

function isDurableDecision(segment: string, first: string, second?: string): boolean {
  const haystack = `${segment} ${first} ${second ?? ""}`;
  if (/\b(?:instead of|over)\b/i.test(haystack)) return true;
  return DURABLE_DECISION_HINT.test(haystack);
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
    // Drop voice/typing fragments at capture time. Mirrors the daemon-side
    // rejectFragmentCandidates filter so trash never enters the candidate
    // queue in the first place.
    if (correction.type !== "review_pattern") {
      const reasons = qualityReasons(correction.text);
      if (reasons.length > 0) continue;
    }

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
        !isDestructiveRisky(updated.text) &&
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
        original_text: text,
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
  if (isDestructiveRisky(candidate.text)) return;

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
