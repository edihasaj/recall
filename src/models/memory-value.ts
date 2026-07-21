import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RecallDb } from "../db/client.js";
import { memories, memoryInjections, memoryValueEvents } from "../db/schema.js";
import type { ActivitySource, FeedbackOutcome, MemoryItem } from "../types.js";
import { getMemory, queryMemories, promoteMemory } from "./memory.js";
import { listInjectedMemoryIdsForSession } from "./memory-injections.js";
import { textMatchScore } from "../text/match.js";
import {
  cosineSimilarity,
  generateEmbedding,
  loadEmbedding,
  loadEmbeddingConfigFromEnv,
} from "../embeddings/embeddings.js";

export type MemoryValueEventType =
  | "injected"
  | "used"
  | FeedbackOutcome
  | "retrieval_miss";

export interface MemoryValueEvidence {
  context?: string;
  query_text?: string;
  correction_text?: string;
  completion_excerpt?: string;
  explicit_memory_ids?: string[];
  prompt_path?: string;
  reason?: string;
  semantic_similarity?: number;
  matched_memory_text?: string;
  injected_memory_ids?: string[];
  pack_tokens_estimate?: number;
}

export interface RecordMemoryValueEventInput {
  memory_id?: string | null;
  injection_id?: string | null;
  feedback_id?: string | null;
  session_id: string;
  repo?: string | null;
  event_type: MemoryValueEventType;
  source: ActivitySource;
  injected_tokens_estimate?: number;
  saved_tokens_estimate?: number;
  evidence?: MemoryValueEvidence;
  created_at?: string;
}

export function estimateTokens(text: string | null | undefined): number {
  const trimmed = text?.trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

export function recordMemoryValueEvent(
  db: RecallDb,
  input: RecordMemoryValueEventInput,
): string {
  const id = randomUUID();
  db.insert(memoryValueEvents)
    .values({
      id,
      memory_id: input.memory_id ?? null,
      injection_id: input.injection_id ?? null,
      feedback_id: input.feedback_id ?? null,
      session_id: input.session_id,
      repo: input.repo ?? null,
      event_type: input.event_type,
      source: input.source,
      injected_tokens_estimate: Math.max(0, Math.round(input.injected_tokens_estimate ?? 0)),
      saved_tokens_estimate: Math.max(0, Math.round(input.saved_tokens_estimate ?? 0)),
      evidence: (input.evidence ?? {}) as any,
      created_at: input.created_at ?? new Date().toISOString(),
    })
    .run();
  return id;
}

export interface MemoryValueBackfillReport {
  scanned_injections: number;
  inserted_injected: number;
  inserted_outcomes: number;
  skipped_existing: number;
  dry_run: boolean;
}

export function backfillMemoryValueEvents(
  db: RecallDb,
  opts: { sinceIso?: string; dryRun?: boolean } = {},
): MemoryValueBackfillReport {
  const rows = db.select({
    id: memoryInjections.id,
    memory_id: memoryInjections.memory_id,
    session_id: memoryInjections.session_id,
    repo: memoryInjections.repo,
    injected_at: memoryInjections.injected_at,
    outcome: memoryInjections.outcome,
    outcome_at: memoryInjections.outcome_at,
    text: memories.text,
  })
    .from(memoryInjections)
    .leftJoin(memories, eq(memoryInjections.memory_id, memories.id))
    .where(opts.sinceIso ? gte(memoryInjections.injected_at, opts.sinceIso) : undefined)
    .all();

  const existingInjected = new Set(
    db.select({ injection_id: memoryValueEvents.injection_id })
      .from(memoryValueEvents)
      .where(eq(memoryValueEvents.event_type, "injected"))
      .all()
      .map((row) => row.injection_id)
      .filter((id): id is string => Boolean(id)),
  );

  const existingOutcomes = new Set(
    db.select({
      injection_id: memoryValueEvents.injection_id,
      event_type: memoryValueEvents.event_type,
    })
      .from(memoryValueEvents)
      .where(inArray(memoryValueEvents.event_type, ["followed", "overridden", "ignored", "contradicted"]))
      .all()
      .filter((row) => row.injection_id)
      .map((row) => `${row.injection_id}:${row.event_type}`),
  );

  const report: MemoryValueBackfillReport = {
    scanned_injections: rows.length,
    inserted_injected: 0,
    inserted_outcomes: 0,
    skipped_existing: 0,
    dry_run: opts.dryRun !== false,
  };

  for (const row of rows) {
    if (existingInjected.has(row.id)) {
      report.skipped_existing += 1;
    } else {
      report.inserted_injected += 1;
      if (!report.dry_run) {
        recordMemoryValueEvent(db, {
          memory_id: row.memory_id,
          injection_id: row.id,
          session_id: row.session_id,
          repo: row.repo,
          event_type: "injected",
          source: "system",
          injected_tokens_estimate: estimateTokens(row.text),
          evidence: {
            matched_memory_text: row.text ?? undefined,
            reason: "backfilled from memory_injections",
          },
          created_at: row.injected_at,
        });
      }
    }

    if (!row.outcome) continue;
    const outcomeKey = `${row.id}:${row.outcome}`;
    if (existingOutcomes.has(outcomeKey)) {
      report.skipped_existing += 1;
      continue;
    }

    report.inserted_outcomes += 1;
    if (!report.dry_run) {
      recordMemoryValueEvent(db, {
        memory_id: row.memory_id,
        injection_id: row.id,
        session_id: row.session_id,
        repo: row.repo,
        event_type: row.outcome,
        source: "system",
        saved_tokens_estimate: row.outcome === "followed" ? estimateTokens(row.text) : 0,
        evidence: {
          matched_memory_text: row.text ?? undefined,
          reason: "backfilled from memory_injections outcome",
        },
        created_at: row.outcome_at ?? row.injected_at,
      });
    }
  }

  return report;
}

export function formatMemoryValueBackfillReport(report: MemoryValueBackfillReport): string {
  const lines = [
    "# Memory Value Backfill",
    "",
    `Mode:              ${report.dry_run ? "dry-run" : "applied"}`,
    `Scanned injects:   ${report.scanned_injections}`,
    `Inserted injected: ${report.inserted_injected}`,
    `Inserted outcomes: ${report.inserted_outcomes}`,
    `Skipped existing:  ${report.skipped_existing}`,
  ];
  return lines.join("\n");
}

export function recordInjectionValueEvents(
  db: RecallDb,
  input: {
    memory_ids: readonly string[];
    session_id?: string;
    repo?: string | null;
    pack_tokens_estimate?: number;
    source?: ActivitySource;
  },
): number {
  if (!input.session_id || input.memory_ids.length === 0) return 0;

  const rows = db.select({
    id: memoryInjections.id,
    memory_id: memoryInjections.memory_id,
  })
    .from(memoryInjections)
    .where(and(
      eq(memoryInjections.session_id, input.session_id),
      inArray(memoryInjections.memory_id, [...input.memory_ids]),
    ))
    .all();

  const existingValueRows = db.select({
    injection_id: memoryValueEvents.injection_id,
  })
    .from(memoryValueEvents)
    .where(and(
      eq(memoryValueEvents.session_id, input.session_id),
      eq(memoryValueEvents.event_type, "injected"),
    ))
    .all();
  const seen = new Set(existingValueRows.map((row) => row.injection_id).filter(Boolean));

  let recorded = 0;
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    const memory = getMemory(db, row.memory_id);
    recordMemoryValueEvent(db, {
      memory_id: row.memory_id,
      injection_id: row.id,
      session_id: input.session_id,
      repo: input.repo ?? memory?.repo ?? null,
      event_type: "injected",
      source: input.source ?? "system",
      injected_tokens_estimate: estimateTokens(memory?.text),
      evidence: {
        matched_memory_text: memory?.text,
        pack_tokens_estimate: input.pack_tokens_estimate,
      },
    });
    recorded += 1;
  }
  return recorded;
}

export function recordOutcomeValueEvent(
  db: RecallDb,
  input: {
    memory_id: string;
    session_id: string;
    injected: boolean;
    outcome: FeedbackOutcome;
    feedback_id: string;
    context?: string;
    source: ActivitySource;
  },
): string {
  const memory = getMemory(db, input.memory_id);
  const injection = input.injected
    ? db.select().from(memoryInjections)
        .where(and(
          eq(memoryInjections.memory_id, input.memory_id),
          eq(memoryInjections.session_id, input.session_id),
        ))
        .get()
    : undefined;

  const savedTokens = input.outcome === "followed"
    ? estimateTokens(memory?.text)
    : 0;

  return recordMemoryValueEvent(db, {
    memory_id: input.memory_id,
    injection_id: injection?.id ?? null,
    feedback_id: input.feedback_id,
    session_id: input.session_id,
    repo: memory?.repo ?? injection?.repo ?? null,
    event_type: input.outcome,
    source: input.source,
    injected_tokens_estimate: 0,
    saved_tokens_estimate: savedTokens,
    evidence: {
      context: input.context,
      matched_memory_text: memory?.text,
    },
  });
}

export interface CompletionUseResult {
  recorded: number;
  memory_ids: string[];
}

export function recordCompletionUseValueEvents(
  db: RecallDb,
  input: {
    session_id: string;
    completion_text: string;
    repo?: string | null;
    memory_ids?: readonly string[];
    source: ActivitySource;
  },
): CompletionUseResult {
  const completionText = input.completion_text.trim();
  if (!completionText) return { recorded: 0, memory_ids: [] };

  const explicitIds = new Set(input.memory_ids ?? []);
  const candidates = injectedMemoriesForCompletionUse(db, input.session_id, input.memory_ids);
  return recordCompletionUseForCandidates(db, input, candidates, (candidate) => {
    if (explicitIds.has(candidate.id)) {
      return {
        matched: true,
        reason: "agent explicitly reported using this injected memory",
      };
    }
    if (completionUsesMemory(completionText, candidate.text)) {
      return {
        matched: true,
        reason: "assistant completion overlapped an injected memory",
      };
    }
    return { matched: false };
  });
}

export async function recordCompletionUseValueEventsSemantic(
  db: RecallDb,
  input: {
    session_id: string;
    completion_text: string;
    repo?: string | null;
    memory_ids?: readonly string[];
    source: ActivitySource;
  },
): Promise<CompletionUseResult> {
  const completionText = input.completion_text.trim();
  if (!completionText) return { recorded: 0, memory_ids: [] };

  const explicitIds = new Set(input.memory_ids ?? []);
  const candidates = injectedMemoriesForCompletionUse(db, input.session_id, input.memory_ids);
  const semanticScores = await semanticScoresForMemories(db, completionText, candidates);
  return recordCompletionUseForCandidates(db, input, candidates, (candidate) => {
    if (explicitIds.has(candidate.id)) {
      return {
        matched: true,
        reason: "agent explicitly reported using this injected memory",
      };
    }
    if (completionUsesMemory(completionText, candidate.text)) {
      return {
        matched: true,
        reason: "assistant completion overlapped an injected memory",
      };
    }
    const semantic = semanticScores.get(candidate.id);
    if (semantic != null && semantic >= semanticValueThreshold()) {
      return {
        matched: true,
        reason: "assistant completion semantically matched an injected memory",
        semantic_similarity: semantic,
      };
    }
    return { matched: false };
  });
}

function recordCompletionUseForCandidates(
  db: RecallDb,
  input: {
    session_id: string;
    completion_text: string;
    repo?: string | null;
    memory_ids?: readonly string[];
    source: ActivitySource;
  },
  candidates: readonly MemoryItem[],
  matcher: (candidate: MemoryItem) => { matched: boolean; reason?: string; semantic_similarity?: number },
): CompletionUseResult {
  const completionText = input.completion_text.trim();
  const explicitIds = new Set(input.memory_ids ?? []);
  const selected = new Map<string, MemoryItem>();
  const evidenceById = new Map<string, { reason?: string; semantic_similarity?: number }>();
  for (const candidate of candidates) {
    const match = matcher(candidate);
    if (match.matched) {
      selected.set(candidate.id, candidate);
      evidenceById.set(candidate.id, {
        reason: match.reason,
        semantic_similarity: match.semantic_similarity,
      });
    }
  }
  if (selected.size === 0) return { recorded: 0, memory_ids: [] };

  const existingRows = db.select({ memory_id: memoryValueEvents.memory_id })
    .from(memoryValueEvents)
    .where(and(
      eq(memoryValueEvents.session_id, input.session_id),
      eq(memoryValueEvents.event_type, "used"),
      inArray(memoryValueEvents.memory_id, [...selected.keys()]),
    ))
    .all();
  const alreadyRecorded = new Set(existingRows.map((row) => row.memory_id).filter(Boolean));

  let recorded = 0;
  for (const memory of selected.values()) {
    if (alreadyRecorded.has(memory.id)) continue;
    const evidence = evidenceById.get(memory.id);
    const injection = db.select()
      .from(memoryInjections)
      .where(and(
        eq(memoryInjections.memory_id, memory.id),
        eq(memoryInjections.session_id, input.session_id),
      ))
      .get();
    recordMemoryValueEvent(db, {
      memory_id: memory.id,
      injection_id: injection?.id ?? null,
      session_id: input.session_id,
      repo: memory.repo ?? input.repo ?? null,
      event_type: "used",
      source: input.source,
      saved_tokens_estimate: estimateTokens(memory.text),
      evidence: {
        completion_excerpt: excerpt(completionText),
        explicit_memory_ids: input.memory_ids ? [...input.memory_ids] : undefined,
        matched_memory_text: memory.text,
        reason: evidence?.reason ?? (explicitIds.has(memory.id)
          ? "agent explicitly reported using this injected memory"
          : "assistant completion overlapped an injected memory"),
        semantic_similarity: evidence?.semantic_similarity,
      },
    });
    recorded += 1;
  }

  return { recorded, memory_ids: [...selected.keys()] };
}

export interface RetrievalMissResult {
  recorded: boolean;
  memory_id: string | null;
  promoted: boolean;
}

export function detectAndRecordRetrievalMisses(
  db: RecallDb,
  input: {
    correction_texts: readonly string[];
    prompt_text: string;
    session_id: string;
    repo?: string | null;
    path?: string;
    source: ActivitySource;
  },
): RetrievalMissResult[] {
  if (input.correction_texts.length === 0) return [];

  const injected = listInjectedMemoryIdsForSession(db, input.session_id);
  const candidates = candidateMemoriesForMissDetection(db, input.repo ?? null);
  const out: RetrievalMissResult[] = [];

  for (const correctionText of input.correction_texts) {
    const match = bestTextMatch(correctionText, candidates);
    if (!match || match.score < 0.62) continue;
    if (injected.has(match.memory.id)) {
      out.push({ recorded: false, memory_id: match.memory.id, promoted: false });
      continue;
    }

    out.push(recordRetrievalMissForMatch(db, {
      ...input,
      correction_text: correctionText,
      injected_memory_ids: [...injected],
      memory: match.memory,
      semantic_similarity: undefined,
    }));
  }

  return out;
}

function recordRetrievalMissForMatch(
  db: RecallDb,
  input: {
    correction_text: string;
    prompt_text: string;
    session_id: string;
    repo?: string | null;
    path?: string;
    source: ActivitySource;
    injected_memory_ids: string[];
    memory: MemoryItem;
    semantic_similarity?: number;
  },
): RetrievalMissResult {
  let promoted = false;
  if (input.memory.status === "candidate") {
    promoted = promoteMemory(db, input.memory.id, "repeat_correction", {
      type: "repeated_correction",
      count: input.memory.repetition_count + 1,
      sessions: [input.session_id],
      timestamp: new Date().toISOString(),
    });
  }

  recordMemoryValueEvent(db, {
    memory_id: input.memory.id,
    session_id: input.session_id,
    repo: input.memory.repo ?? input.repo ?? null,
    event_type: "retrieval_miss",
    source: input.source,
    saved_tokens_estimate: 0,
    evidence: {
      correction_text: input.correction_text,
      query_text: input.prompt_text,
      prompt_path: input.path,
      matched_memory_text: input.memory.text,
      injected_memory_ids: input.injected_memory_ids,
      semantic_similarity: input.semantic_similarity,
      reason: promoted
        ? "matching candidate was repeated but not injected; promoted for future turns"
        : input.semantic_similarity != null
          ? "matching memory semantically matched a repeated correction but was not injected"
          : "matching memory existed but was not injected before the correction repeated",
    },
  });

  return { recorded: true, memory_id: input.memory.id, promoted };
}

export async function detectAndRecordRetrievalMissesSemantic(
  db: RecallDb,
  input: {
    correction_texts: readonly string[];
    prompt_text: string;
    session_id: string;
    repo?: string | null;
    path?: string;
    source: ActivitySource;
  },
): Promise<RetrievalMissResult[]> {
  if (input.correction_texts.length === 0) return [];

  const injected = listInjectedMemoryIdsForSession(db, input.session_id);
  const candidates = candidateMemoriesForMissDetection(db, input.repo ?? null);
  const out: RetrievalMissResult[] = [];

  for (const correctionText of input.correction_texts) {
    const lexical = bestTextMatch(correctionText, candidates);
    const semantic = await bestSemanticMatch(db, correctionText, candidates);
    const match = betterMatch(lexical, semantic);
    if (!match || match.score < 0.62) continue;
    if (injected.has(match.memory.id)) {
      out.push({ recorded: false, memory_id: match.memory.id, promoted: false });
      continue;
    }

    const result = recordRetrievalMissForMatch(db, {
      ...input,
      correction_text: correctionText,
      injected_memory_ids: [...injected],
      memory: match.memory,
      semantic_similarity: match.semantic ? match.score : undefined,
    });
    out.push(result);
  }

  return out;
}

export interface MemoryValueReport {
  window_start: string;
  window_end: string;
  events_total: number;
  injections: number;
  used: number;
  outcomes: Record<string, number>;
  retrieval_misses: number;
  injected_tokens_estimate: number;
  saved_tokens_estimate: number;
  net_tokens_estimate: number;
  top_savers: Array<{
    memory_id: string;
    text: string;
    saved_tokens_estimate: number;
    used: number;
    followed: number;
  }>;
}

export function computeMemoryValueReport(
  db: RecallDb,
  opts: { sinceIso?: string } = {},
): MemoryValueReport {
  const now = new Date();
  const start = opts.sinceIso ?? new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const end = now.toISOString();

  const totals = db.select({
    events_total: sql<number>`count(*)`.as("events_total"),
    injections: sql<number>`sum(case when ${memoryValueEvents.event_type} = 'injected' then 1 else 0 end)`.as("injections"),
    used: sql<number>`sum(case when ${memoryValueEvents.event_type} = 'used' then 1 else 0 end)`.as("used"),
    retrieval_misses: sql<number>`sum(case when ${memoryValueEvents.event_type} = 'retrieval_miss' then 1 else 0 end)`.as("retrieval_misses"),
    injected_tokens_estimate: sql<number>`coalesce(sum(${memoryValueEvents.injected_tokens_estimate}), 0)`.as("injected_tokens_estimate"),
    saved_tokens_estimate: sql<number>`coalesce(sum(${memoryValueEvents.saved_tokens_estimate}), 0)`.as("saved_tokens_estimate"),
  })
    .from(memoryValueEvents)
    .where(gte(memoryValueEvents.created_at, start))
    .get();

  const outcomeRows = db.select({
    outcome: memoryValueEvents.event_type,
    count: sql<number>`count(*)`.as("count"),
  })
    .from(memoryValueEvents)
    .where(and(
      gte(memoryValueEvents.created_at, start),
      inArray(memoryValueEvents.event_type, ["followed", "overridden", "ignored", "contradicted"]),
    ))
    .groupBy(memoryValueEvents.event_type)
    .all();

  const topRows = db.select({
    memory_id: memoryValueEvents.memory_id,
    text: memories.text,
    saved_tokens_estimate: sql<number>`coalesce(sum(${memoryValueEvents.saved_tokens_estimate}), 0)`.as("saved_tokens_estimate"),
    used: sql<number>`sum(case when ${memoryValueEvents.event_type} = 'used' then 1 else 0 end)`.as("used"),
    followed: sql<number>`sum(case when ${memoryValueEvents.event_type} = 'followed' then 1 else 0 end)`.as("followed"),
  })
    .from(memoryValueEvents)
    .leftJoin(memories, eq(memoryValueEvents.memory_id, memories.id))
    .where(and(
      gte(memoryValueEvents.created_at, start),
      inArray(memoryValueEvents.event_type, ["followed", "used"]),
    ))
    .groupBy(memoryValueEvents.memory_id, memories.text)
    .orderBy(desc(sql`coalesce(sum(${memoryValueEvents.saved_tokens_estimate}), 0)`))
    .limit(5)
    .all();

  const outcomes: Record<string, number> = {};
  for (const row of outcomeRows) outcomes[row.outcome] = row.count;

  const injectedTokens = Number(totals?.injected_tokens_estimate ?? 0);
  const savedTokens = Number(totals?.saved_tokens_estimate ?? 0);

  return {
    window_start: start,
    window_end: end,
    events_total: Number(totals?.events_total ?? 0),
    injections: Number(totals?.injections ?? 0),
    used: Number(totals?.used ?? 0),
    outcomes,
    retrieval_misses: Number(totals?.retrieval_misses ?? 0),
    injected_tokens_estimate: injectedTokens,
    saved_tokens_estimate: savedTokens,
    net_tokens_estimate: savedTokens - injectedTokens,
    top_savers: topRows
      .filter((row) => row.memory_id && row.text)
      .map((row) => ({
        memory_id: row.memory_id!,
        text: row.text!,
        saved_tokens_estimate: Number(row.saved_tokens_estimate ?? 0),
        used: Number(row.used ?? 0),
        followed: Number(row.followed ?? 0),
      })),
  };
}

function candidateMemoriesForMissDetection(
  db: RecallDb,
  repo: string | null,
): MemoryItem[] {
  const repoMemories = repo ? queryMemories(db, { repo }) : [];
  const globalMemories = queryMemories(db, { scope: "global" });
  return [...repoMemories, ...globalMemories]
    .filter((memory, index, rows) =>
      (memory.status === "active" || memory.status === "candidate") &&
      rows.findIndex((candidate) => candidate.id === memory.id) === index
    );
}

function injectedMemoriesForCompletionUse(
  db: RecallDb,
  sessionId: string,
  memoryIds: readonly string[] | undefined,
): MemoryItem[] {
  const injectedIds = listInjectedMemoryIdsForSession(db, sessionId);
  const wanted = memoryIds && memoryIds.length > 0
    ? [...new Set(memoryIds)].filter((id) => injectedIds.has(id))
    : [...injectedIds];
  if (wanted.length === 0) return [];

  return wanted
    .map((id) => getMemory(db, id))
    .filter((memory): memory is MemoryItem => Boolean(memory));
}

function completionUsesMemory(completionText: string, memoryText: string): boolean {
  const match = textMatchScore(completionText, memoryText);
  return match.score >= 0.62 || (match.intersection >= 3 && match.containment >= 0.6);
}

async function bestSemanticMatch(
  db: RecallDb,
  text: string,
  memoriesToCheck: readonly MemoryItem[],
): Promise<{ memory: MemoryItem; score: number; semantic: true } | null> {
  const scores = await semanticScoresForMemories(db, text, memoriesToCheck);
  let best: { memory: MemoryItem; score: number; semantic: true } | null = null;
  for (const memory of memoriesToCheck) {
    const score = scores.get(memory.id);
    if (score == null) continue;
    if (!best || score > best.score) best = { memory, score, semantic: true };
  }
  return best && best.score >= semanticValueThreshold() ? best : null;
}

function betterMatch(
  lexical: { memory: MemoryItem; score: number } | null,
  semantic: { memory: MemoryItem; score: number; semantic: true } | null,
): { memory: MemoryItem; score: number; semantic?: true } | null {
  if (!lexical) return semantic;
  if (!semantic) return lexical;
  return semantic.score > lexical.score ? semantic : lexical;
}

function bestTextMatch(
  text: string,
  memoriesToCheck: readonly MemoryItem[],
): { memory: MemoryItem; score: number } | null {
  let best: { memory: MemoryItem; score: number } | null = null;
  for (const memory of memoriesToCheck) {
    const score = textMatchScore(text, memory.text).score;
    if (!best || score > best.score) best = { memory, score };
  }
  return best;
}

async function semanticScoresForMemories(
  db: RecallDb,
  text: string,
  memoriesToCheck: readonly MemoryItem[],
): Promise<Map<string, number>> {
  const config = loadEmbeddingConfigFromEnv();
  if (!config || memoriesToCheck.length === 0) return new Map();

  try {
    const query = await generateEmbedding(text, config, "query");
    const scores = new Map<string, number>();
    for (const memory of memoriesToCheck) {
      const stored = loadEmbedding(db, memory.id);
      if (!stored || stored.length !== query.length) continue;
      scores.set(memory.id, cosineSimilarity(query, stored));
    }
    return scores;
  } catch {
    return new Map();
  }
}

function semanticValueThreshold(): number {
  const raw = process.env.RECALL_VALUE_SEMANTIC_THRESHOLD;
  if (!raw) return 0.78;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.78;
}

function excerpt(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= 320 ? compact : `${compact.slice(0, 319)}…`;
}
