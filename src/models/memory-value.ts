import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RecallDb } from "../db/client.js";
import { memories, memoryInjections, memoryValueEvents } from "../db/schema.js";
import type { ActivitySource, FeedbackOutcome, MemoryItem } from "../types.js";
import { getMemory, queryMemories, promoteMemory } from "./memory.js";
import { listInjectedMemoryIdsForSession } from "./memory-injections.js";

export type MemoryValueEventType =
  | "injected"
  | FeedbackOutcome
  | "retrieval_miss";

export interface MemoryValueEvidence {
  context?: string;
  query_text?: string;
  correction_text?: string;
  prompt_path?: string;
  reason?: string;
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
      created_at: new Date().toISOString(),
    })
    .run();
  return id;
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

    let promoted = false;
    if (match.memory.status === "candidate") {
      promoted = promoteMemory(db, match.memory.id, "repeat_correction", {
        type: "repeated_correction",
        count: match.memory.repetition_count + 1,
        sessions: [input.session_id],
        timestamp: new Date().toISOString(),
      });
    }

    recordMemoryValueEvent(db, {
      memory_id: match.memory.id,
      session_id: input.session_id,
      repo: match.memory.repo ?? input.repo ?? null,
      event_type: "retrieval_miss",
      source: input.source,
      saved_tokens_estimate: 0,
      evidence: {
        correction_text: correctionText,
        query_text: input.prompt_text,
        prompt_path: input.path,
        matched_memory_text: match.memory.text,
        injected_memory_ids: [...injected],
        reason: promoted
          ? "matching candidate was repeated but not injected; promoted for future turns"
          : "matching memory existed but was not injected before the correction repeated",
      },
    });

    out.push({ recorded: true, memory_id: match.memory.id, promoted });
  }

  return out;
}

export interface MemoryValueReport {
  window_start: string;
  window_end: string;
  events_total: number;
  injections: number;
  outcomes: Record<string, number>;
  retrieval_misses: number;
  injected_tokens_estimate: number;
  saved_tokens_estimate: number;
  net_tokens_estimate: number;
  top_savers: Array<{
    memory_id: string;
    text: string;
    saved_tokens_estimate: number;
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
    followed: sql<number>`sum(case when ${memoryValueEvents.event_type} = 'followed' then 1 else 0 end)`.as("followed"),
  })
    .from(memoryValueEvents)
    .leftJoin(memories, eq(memoryValueEvents.memory_id, memories.id))
    .where(and(
      gte(memoryValueEvents.created_at, start),
      eq(memoryValueEvents.event_type, "followed"),
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

function bestTextMatch(
  text: string,
  memoriesToCheck: readonly MemoryItem[],
): { memory: MemoryItem; score: number } | null {
  let best: { memory: MemoryItem; score: number } | null = null;
  for (const memory of memoriesToCheck) {
    const score = jaccard(text, memory.text);
    if (!best || score > best.score) best = { memory, score };
  }
  return best;
}

function jaccard(a: string, b: string): number {
  const wordsA = new Set(tokens(a));
  const wordsB = new Set(tokens(b));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const intersection = [...wordsA].filter((word) => wordsB.has(word));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.length / union.size;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}
