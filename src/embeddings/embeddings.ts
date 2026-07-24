/**
 * Local embedding lifecycle.
 * Canonical embedding rows live in SQLite; derived vec + FTS indexes sit on top.
 */

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { memories, memoryEmbeddings } from "../db/schema.js";
import { CONFIDENCE, type EmbeddingConfig, type EvidenceEntry, type MemoryItem } from "../types.js";
import { formatBytes, getDirectorySize, getEmbeddingCachePath } from "./cache.js";
import { resolveProvider } from "./providers/index.js";
import type { EmbeddingPurpose } from "./providers/types.js";
import {
  rebuildMemoryVecIndex,
  removeMemoryVecRow,
  searchMemoryVecIndex,
  upsertMemoryVecRow,
  verifyMemoryVecIndex,
} from "../vector/sqlite-vec.js";
import {
  rebuildMemoryFtsIndex,
  searchMemoryFtsIndex,
  syncMemoryFtsIndex,
  verifyMemoryFtsIndex,
} from "../vector/sqlite-fts.js";
import { generateHydeText } from "./hyde.js";
import { isRerankerEnabled, rerankerTopK, rerankPairs } from "./reranker.js";

type MemoryRow = typeof memories.$inferSelect;
type MemoryEmbeddingRow = typeof memoryEmbeddings.$inferSelect;

const EMBEDDING_BATCH_SIZE = 100;
// Lower-bound for accepting a vector match into the hybrid result. Tuned for
// short coding-rule corpora at 0.7 (rules look very similar embedded so the
// floor keeps off-topic matches out). For retrieval evals over conversational
// haystacks (e.g. LongMemEval) cosine similarity sits much lower per chunk;
// override via RECALL_HYBRID_MIN_SIM.
const MIN_HYBRID_VECTOR_SIMILARITY = (() => {
  const raw = process.env.RECALL_HYBRID_MIN_SIM;
  if (!raw) return 0.7;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return 0.7;
  return parsed;
})();
const pendingEmbeddingJobs = new Set<Promise<void>>();
const EMBEDDING_DEFAULTS = {
  nomic: {
    model: "nomic-ai/nomic-embed-text-v1.5",
    dimensions: 512,
  },
  "multilingual-e5": {
    model: "Xenova/multilingual-e5-small",
    dimensions: 384,
  },
  "bge-small-en-v1.5": {
    model: "Xenova/bge-small-en-v1.5",
    dimensions: 384,
  },
  "all-MiniLM-L6-v2": {
    model: "Xenova/all-MiniLM-L6-v2",
    dimensions: 384,
  },
} as const;

// --- Config ---

export function loadEmbeddingConfigFromEnv(): EmbeddingConfig | null {
  if (process.env.RECALL_EMBEDDINGS_DISABLED === "true") return null;
  const requested = process.env.RECALL_EMBEDDING_PROVIDER;
  const provider: EmbeddingConfig["provider"] = requested === "multilingual-e5"
    ? "multilingual-e5"
    : requested === "bge-small-en-v1.5"
    ? "bge-small-en-v1.5"
    : requested === "all-MiniLM-L6-v2"
    ? "all-MiniLM-L6-v2"
    : "nomic";
  const defaults = EMBEDDING_DEFAULTS[provider];
  return {
    provider,
    model: process.env.RECALL_EMBEDDING_MODEL ?? defaults.model,
    dimensions: parseInt(process.env.RECALL_EMBEDDING_DIMS ?? `${defaults.dimensions}`, 10),
    version: process.env.RECALL_EMBEDDING_VERSION ?? "v1",
    similarity_threshold: parseFloat(process.env.RECALL_SIMILARITY_THRESHOLD ?? "0.8"),
  };
}

export function getEmbeddingModelInfo(
  config: EmbeddingConfig | null = loadEmbeddingConfigFromEnv(),
): {
  provider: EmbeddingConfig["provider"];
  model: string;
  dimensions: number;
  canonical_dimensions: number;
  index_dimensions: number;
  version: string;
  task_prefix?: string;
  estimated_size_mb?: number;
  cache_path: string;
  cached: boolean;
  size_bytes: number;
  size_label: string;
} | null {
  if (!config) return null;

  const provider = resolveProvider(config);
  const metadata = provider.metadata();
  const cachePath = getEmbeddingCachePath({
    provider: config.provider,
    model: metadata.model,
  });
  const sizeBytes = getDirectorySize(cachePath);

  return {
    provider: config.provider,
    model: metadata.model,
    dimensions: metadata.dimensions,
    canonical_dimensions: metadata.canonical_dimensions,
    index_dimensions: metadata.index_dimensions,
    version: metadata.version,
    task_prefix: metadata.task_prefix,
    estimated_size_mb: metadata.estimated_size_mb,
    cache_path: cachePath,
    cached: sizeBytes > 0,
    size_bytes: sizeBytes,
    size_label: formatBytes(sizeBytes),
  };
}

export async function ensureEmbeddingProviderReady(
  config: EmbeddingConfig | null = loadEmbeddingConfigFromEnv(),
) {
  if (!config) return null;

  const provider = resolveProvider(config);
  if (provider.prepare) {
    await provider.prepare();
  } else {
    await provider.embed("recall provider warmup", "document");
  }

  return getEmbeddingModelInfo(config);
}

function getEmbeddingVersion(config: EmbeddingConfig): string {
  return config.version || `${config.provider}:${config.model}:${config.dimensions}`;
}

function hashMemoryText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function shouldEmbedMemory(row: Pick<MemoryRow, "status" | "confidence" | "source">): boolean {
  if (row.status === "transient") return false;
  // Phase D.next: rejected memories that came from a user correction stay
  // embedded so capture can do semantic-paraphrase matching against the
  // rejection corpus. Other rejected memories (e.g. from cleanup
  // dedupe-merge) don't need embeddings — there's no value in matching
  // against superseded duplicates.
  if (row.status === "rejected") {
    return row.source === "user_correction" || row.source === "user_reported_review";
  }
  return row.confidence >= CONFIDENCE.TRANSIENT_MAX;
}

function serializeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(
    embedding.buffer,
    embedding.byteOffset,
    embedding.byteLength,
  );
}

function deserializeEmbedding(buffer: Buffer): Float32Array {
  return new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
}

function rowNeedsEmbeddingRefresh(
  row: Pick<MemoryRow, "text">,
  existing: MemoryEmbeddingRow | undefined,
  config: EmbeddingConfig,
): boolean {
  const metadata = resolveProvider(config).metadata();
  if (!existing) return true;
  return (
    existing.model !== config.model ||
    existing.embedding_dimensions !== metadata.canonical_dimensions ||
    existing.index_dimensions !== metadata.index_dimensions ||
    existing.version !== getEmbeddingVersion(config) ||
    existing.content_hash !== hashMemoryText(row.text)
  );
}

export function projectEmbeddingToIndex(
  embedding: Float32Array,
  indexDimensions: number,
): Float32Array {
  if (embedding.length === indexDimensions) {
    return embedding;
  }
  if (embedding.length < indexDimensions) {
    throw new Error(`Embedding width ${embedding.length} is smaller than index width ${indexDimensions}.`);
  }

  const sliced = embedding.slice(0, indexDimensions);
  let norm = 0;
  for (const value of sliced) norm += value * value;
  const scale = Math.sqrt(norm) || 1;
  for (let i = 0; i < sliced.length; i++) {
    sliced[i] /= scale;
  }
  return sliced;
}

// --- Embedding generation ---

export async function generateEmbedding(
  text: string,
  config: EmbeddingConfig,
  purpose: EmbeddingPurpose = "document",
): Promise<Float32Array> {
  return resolveProvider(config).embed(text, purpose);
}

// --- Batch embedding ---

export async function generateEmbeddings(
  texts: string[],
  config: EmbeddingConfig,
  purpose: EmbeddingPurpose = "document",
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  return resolveProvider(config).embedBatch(texts, purpose);
}

// --- Storage ---

export function storeEmbedding(
  db: RecallDb,
  memoryId: string,
  text: string,
  embedding: Float32Array,
  config: EmbeddingConfig,
) {
  const now = new Date().toISOString();
  const metadata = resolveProvider(config).metadata();
  const payload = {
    memory_id: memoryId,
    model: config.model,
    embedding_dimensions: metadata.canonical_dimensions,
    index_dimensions: metadata.index_dimensions,
    version: getEmbeddingVersion(config),
    content_hash: hashMemoryText(text),
    updated_at: now,
    embedding: serializeEmbedding(embedding),
  };

  db.insert(memoryEmbeddings)
    .values(payload)
    .onConflictDoUpdate({
      target: memoryEmbeddings.memory_id,
      set: {
        model: payload.model,
        embedding_dimensions: payload.embedding_dimensions,
        index_dimensions: payload.index_dimensions,
        version: payload.version,
        content_hash: payload.content_hash,
        updated_at: payload.updated_at,
        embedding: payload.embedding,
      },
    })
    .run();
}

export function removeStoredEmbedding(
  db: RecallDb,
  memoryId: string,
): boolean {
  const result = db.delete(memoryEmbeddings)
    .where(eq(memoryEmbeddings.memory_id, memoryId))
    .run();
  return result.changes > 0;
}

export function loadEmbedding(
  db: RecallDb,
  memoryId: string,
): Float32Array | null {
  const row = db
    .select({ embedding: memoryEmbeddings.embedding })
    .from(memoryEmbeddings)
    .where(eq(memoryEmbeddings.memory_id, memoryId))
    .get();

  if (!row?.embedding) return null;
  return deserializeEmbedding(row.embedding as Buffer);
}

// --- Lifecycle ---

export async function syncMemoryEmbedding(
  db: RecallDb,
  memoryId: string,
  config: EmbeddingConfig,
): Promise<"stored" | "updated" | "removed" | "skipped"> {
  const memory = db
    .select()
    .from(memories)
    .where(eq(memories.id, memoryId))
    .get();

  if (!memory || !shouldEmbedMemory(memory)) {
    removeStoredEmbedding(db, memoryId);
    removeMemoryVecRow(db, memoryId, config);
    return "removed";
  }

  const existing = db
    .select()
    .from(memoryEmbeddings)
    .where(eq(memoryEmbeddings.memory_id, memoryId))
    .get();

  if (!rowNeedsEmbeddingRefresh(memory, existing, config)) {
    if (existing) {
      upsertMemoryVecRow(db, memory, existing);
    }
    return "skipped";
  }

  const embedding = await generateEmbedding(memory.text, config, "document");

  // Embedding generation is async; the parent memory may have been deleted
  // (e.g. test cleanup, hard-delete of a candidate) while we awaited. Skip the
  // insert in that case rather than tripping the FK on memory_embeddings.
  const stillExists = db
    .select({ id: memories.id })
    .from(memories)
    .where(eq(memories.id, memoryId))
    .get();
  if (!stillExists) {
    removeStoredEmbedding(db, memoryId);
    removeMemoryVecRow(db, memoryId, config);
    return "removed";
  }

  storeEmbedding(db, memory.id, memory.text, embedding, config);
  const refreshed = db
    .select()
    .from(memoryEmbeddings)
    .where(eq(memoryEmbeddings.memory_id, memory.id))
    .get();
  if (!refreshed) {
    throw new Error(`Failed to reload embedding row for ${memory.id}`);
  }
  upsertMemoryVecRow(db, memory, refreshed);
  return existing ? "updated" : "stored";
}

export function queueMemoryEmbeddingSync(
  db: RecallDb,
  memoryId: string,
  config: EmbeddingConfig | null = loadEmbeddingConfigFromEnv(),
): Promise<void> | null {
  syncMemoryFtsIndex(db, memoryId);

  if (!config) return null;

  const job = syncMemoryEmbedding(db, memoryId, config)
    .then(() => undefined)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[recall] embedding sync failed:", {
        memory_id: memoryId.slice(0, 8),
        error: message,
      });
    })
    .finally(() => {
      pendingEmbeddingJobs.delete(job);
    });

  pendingEmbeddingJobs.add(job);
  return job;
}

export async function flushEmbeddingJobs() {
  if (pendingEmbeddingJobs.size === 0) return;
  await Promise.allSettled([...pendingEmbeddingJobs]);
}

export async function bootstrapEmbeddings(
  db: RecallDb,
  config: EmbeddingConfig,
  options: { repo?: string } = {},
): Promise<number> {
  const rows = db.select().from(memories).all();
  const existingRows = db.select().from(memoryEmbeddings).all();
  const existingById = new Map(existingRows.map((row) => [row.memory_id, row]));

  const eligible = rows.filter((row) => {
    if (options.repo && row.repo !== options.repo) return false;
    return shouldEmbedMemory(row);
  });

  const pending = eligible.filter((row) => rowNeedsEmbeddingRefresh(row, existingById.get(row.id), config));

  for (const row of rows) {
    if (options.repo && row.repo !== options.repo) continue;
    if (!shouldEmbedMemory(row)) {
      removeStoredEmbedding(db, row.id);
      removeMemoryVecRow(db, row.id, config);
    }
  }

  let total = 0;
  for (let i = 0; i < pending.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = pending.slice(i, i + EMBEDDING_BATCH_SIZE);
    const embeddings = await generateEmbeddings(
      batch.map((row) => row.text),
      config,
      "document",
    );

    for (let j = 0; j < batch.length; j++) {
      storeEmbedding(db, batch[j].id, batch[j].text, embeddings[j], config);
      total++;
    }
  }

  rebuildMemoryFtsIndex(db, options);
  rebuildMemoryVecIndex(db, config, options);
  return total;
}

export function verifyEmbeddings(
  db: RecallDb,
  config: EmbeddingConfig,
  options: { repo?: string } = {},
) {
  const rows = db.select().from(memories).all();
  const embeddingRows = db.select().from(memoryEmbeddings).all();
  const embeddingById = new Map(embeddingRows.map((row) => [row.memory_id, row]));

  let eligible = 0;
  let stale = 0;
  for (const row of rows) {
    if (options.repo && row.repo !== options.repo) continue;
    if (!shouldEmbedMemory(row)) continue;
    eligible++;

    if (rowNeedsEmbeddingRefresh(row, embeddingById.get(row.id), config)) {
      stale++;
    }
  }

  const vec = verifyMemoryVecIndex(db, options);
  const fts = verifyMemoryFtsIndex(db, options);
  return {
    eligible,
    stored: embeddingRows.filter((row) => {
      if (!options.repo) return true;
      const memory = rows.find((item) => item.id === row.memory_id);
      return memory?.repo === options.repo;
    }).length,
    stale,
    indexed: vec.indexed,
    index_drift: vec.drift,
    lexical_indexed: fts.indexed,
    lexical_drift: fts.drift,
  };
}

export function rebuildEmbeddingIndex(
  db: RecallDb,
  config: EmbeddingConfig | null,
  options: { repo?: string } = {},
) {
  const lexicalRows = rebuildMemoryFtsIndex(db, options);
  const vectorRows = config
    ? rebuildMemoryVecIndex(db, config, options)
    : 0;
  return {
    vector_rows: vectorRows,
    lexical_rows: lexicalRows,
  };
}

function lexicalRankToScore(rank: number, position: number): number {
  const safeRank = Number.isFinite(rank) ? Math.abs(rank) : position + 1;
  return 1 / (1 + safeRank + position);
}

const DEFAULT_LEX_WEIGHT = 0.35;
const DEFAULT_VEC_WEIGHT = 0.65;
const DEFAULT_RRF_K = 60;
// Slight lex bias picked by benchmark/fusion-sweep.ts on
// benchmark/data/recall-lme-e5-n60-tier1.json. With Porter+synonyms+prefix
// the FTS arm is strong enough to outperform vec on conversational
// haystacks; on coding rules the modest 1.25/0.75 split keeps vec
// contributing meaningfully for vague queries. 1:1 is the next-best option.
const DEFAULT_RRF_LEX_WEIGHT = 1.25;
const DEFAULT_RRF_VEC_WEIGHT = 0.75;

function readFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

export async function hybridSearch(
  db: RecallDb,
  query: string,
  config: EmbeddingConfig | null,
  options: { repo?: string; limit?: number } = {},
): Promise<Array<{
  memory: MemoryItem;
  score: number;
  similarity: number;
  lexical_score: number;
}>> {
  const limit = options.limit ?? 10;
  const minSimilarity = config
    ? Math.max(config.similarity_threshold, MIN_HYBRID_VECTOR_SIMILARITY)
    : null;

  // Pull a wider window (10x final limit, min 50) into each arm so RRF has
  // enough headroom to recombine. Old code pulled 2x/min-20 which starves the
  // fusion for natural-language queries where the right answer often sits at
  // rank 8–15 in one arm.
  const armLimit = Math.max(limit * 10, 50);
  const lexicalMatches = searchMemoryFtsIndex(db, query, {
    repo: options.repo,
    limit: armLimit,
  });
  // HyDE: if enabled and the query looks like a chat question, embed a
  // 1-sentence hypothetical answer instead of the question itself. Lex arm
  // keeps the original query (still want the original terms in BM25).
  const hydeText = config ? await generateHydeText(db, query) : null;
  const vecEmbedQuery = hydeText ?? query;
  const semanticMatches = config
    ? searchMemoryVecIndex(
        db,
        projectEmbeddingToIndex(
          await generateEmbedding(vecEmbedQuery, config, "query"),
          resolveProvider(config).metadata().index_dimensions,
        ),
        { repo: options.repo, limit: armLimit },
      )
    : [];

  const rowsById = new Map(
    db.select().from(memories).all().map((row) => [row.id, row]),
  );

  // RECALL_FUSION=weighted falls back to the legacy weighted-sum so the
  // ablation harness can compare on the same data.
  const fusionMode =
    process.env.RECALL_FUSION === "weighted" ? "weighted" : "rrf";
  const rrfK = readFloat("RECALL_RRF_K", DEFAULT_RRF_K);
  const rrfLexW = readFloat("RECALL_RRF_LEX_WEIGHT", DEFAULT_RRF_LEX_WEIGHT);
  const rrfVecW = readFloat("RECALL_RRF_VEC_WEIGHT", DEFAULT_RRF_VEC_WEIGHT);
  const lexW = readFloat("RECALL_LEX_WEIGHT", DEFAULT_LEX_WEIGHT);
  const vecW = readFloat("RECALL_VEC_WEIGHT", DEFAULT_VEC_WEIGHT);

  const merged = new Map<string, {
    memory: MemoryItem;
    similarity: number;
    lexical_score: number;
    score: number;
  }>();

  for (let i = 0; i < lexicalMatches.length; i++) {
    const match = lexicalMatches[i];
    const row = rowsById.get(match.memory_id);
    if (!row || !shouldEmbedMemory(row)) continue;

    const lexicalScore = lexicalRankToScore(match.lexical_rank, i);
    const initialScore =
      fusionMode === "rrf" ? (rrfLexW / (rrfK + i + 1)) : lexicalScore * lexW;
    merged.set(match.memory_id, {
      memory: rowToMemory(row),
      similarity: 0,
      lexical_score: lexicalScore,
      score: initialScore,
    });
  }

  for (let i = 0; i < semanticMatches.length; i++) {
    const match = semanticMatches[i];
    const row = rowsById.get(match.memory_id);
    if (!row || !shouldEmbedMemory(row)) continue;

    const similarity = Math.max(0, 1 - match.distance);
    if (minSimilarity !== null && similarity < minSimilarity) continue;

    const existing = merged.get(match.memory_id);
    const vecContribution =
      fusionMode === "rrf" ? (rrfVecW / (rrfK + i + 1)) : similarity * vecW;
    if (existing) {
      existing.similarity = similarity;
      existing.score += vecContribution;
    } else {
      merged.set(match.memory_id, {
        memory: rowToMemory(row),
        similarity,
        lexical_score: 0,
        score: vecContribution,
      });
    }
  }

  const sorted = [...merged.values()].sort((a, b) => b.score - a.score);

  // Cross-encoder re-rank: pull a wider window (default top-50), score each
  // (query, doc) pair jointly, then keep the limit-N best. Skip silently on
  // any failure — the fused order is already a sensible fallback.
  if (isRerankerEnabled() && sorted.length > 1) {
    const topK = Math.min(rerankerTopK(), sorted.length);
    const candidates = sorted.slice(0, topK);
    try {
      const scores = await rerankPairs(
        query,
        candidates.map((c) => c.memory.text),
      );
      const rescored = candidates
        .map((c, i) => ({ ...c, score: scores[i] ?? 0 }))
        .sort((a, b) => b.score - a.score);
      return rescored.slice(0, limit);
    } catch {
      // Fall through to the un-reranked fused order.
    }
  }

  return sorted.slice(0, limit);
}

// --- Cosine similarity ---

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// --- Semantic search ---

export async function semanticSearch(
  db: RecallDb,
  query: string,
  config: EmbeddingConfig,
  options: { repo?: string; limit?: number } = {},
): Promise<Array<{ memory: MemoryItem; similarity: number }>> {
  const queryEmbedding = projectEmbeddingToIndex(
    await generateEmbedding(query, config, "query"),
    resolveProvider(config).metadata().index_dimensions,
  );
  const matches = searchMemoryVecIndex(db, queryEmbedding, options);
  if (matches.length === 0) return [];

  const rowsById = new Map(
    db.select().from(memories).all().map((row) => [row.id, row]),
  );

  return matches
    .map((match) => {
      const row = rowsById.get(match.memory_id);
      if (!row || !shouldEmbedMemory(row)) return null;
      const similarity = 1 - match.distance;
      if (similarity < config.similarity_threshold) return null;
      return {
        memory: rowToMemory(row),
        similarity,
      };
    })
    .filter((item): item is { memory: MemoryItem; similarity: number } => item !== null)
    .sort((a, b) => b.similarity - a.similarity);
}

// --- Semantic dedup ---

export async function findSemanticDuplicates(
  db: RecallDb,
  text: string,
  config: EmbeddingConfig,
  threshold?: number,
  options: { repo?: string; type?: MemoryItem["type"]; limit?: number } = {},
): Promise<Array<{ id: string; text: string; similarity: number }>> {
  const queryEmbedding = await generateEmbedding(text, config, "query");
  const dupThreshold = threshold ?? config.similarity_threshold;

  const rows = db.select().from(memories).all();
  const embeddingsById = new Map(
    db.select().from(memoryEmbeddings).all().map((row) => [row.memory_id, row]),
  );

  const duplicates: Array<{ id: string; text: string; similarity: number }> = [];

  for (const row of rows) {
    if (options.repo && row.repo !== options.repo) continue;
    if (options.type && row.type !== options.type) continue;
    // Dedup is for live memories; rejected exemplars are intentionally not
    // matched here so a new candidate doesn't get linked to a rejected row.
    if (row.status === "rejected") continue;
    if (!shouldEmbedMemory(row)) continue;

    const embeddingRow = embeddingsById.get(row.id);
    if (!embeddingRow?.embedding) continue;

    const similarity = cosineSimilarity(
      queryEmbedding,
      deserializeEmbedding(embeddingRow.embedding as Buffer),
    );

    if (similarity >= dupThreshold) {
      duplicates.push({ id: row.id, text: row.text, similarity });
    }
  }

  return duplicates
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, options.limit ?? 10);
}

// Phase D.next: paraphrase-aware lookup against the rejected exemplar corpus.
// Returns the highest-similarity rejected user_correction whose embedding
// exceeds the threshold, or null. Used by capture to skip new candidates that
// are semantically equivalent to something the user already rejected.
export async function findSimilarRejectedExemplar(
  db: RecallDb,
  text: string,
  config: EmbeddingConfig,
  threshold: number,
): Promise<{ id: string; text: string; similarity: number } | null> {
  const queryEmbedding = await generateEmbedding(text, config, "query");

  const rejectedRows = db.select().from(memories)
    .where(eq(memories.status, "rejected"))
    .all()
    .filter((row) => row.source === "user_correction" || row.source === "user_reported_review");

  if (rejectedRows.length === 0) return null;

  const embeddingsById = new Map(
    db.select().from(memoryEmbeddings).all().map((row) => [row.memory_id, row]),
  );

  let best: { id: string; text: string; similarity: number } | null = null;
  for (const row of rejectedRows) {
    const embeddingRow = embeddingsById.get(row.id);
    if (!embeddingRow?.embedding) continue;
    const similarity = cosineSimilarity(
      queryEmbedding,
      deserializeEmbedding(embeddingRow.embedding as Buffer),
    );
    if (similarity >= threshold && (!best || similarity > best.similarity)) {
      best = { id: row.id, text: row.text, similarity };
    }
  }

  return best;
}

// --- Helpers ---

function rowToMemory(row: MemoryRow): MemoryItem {
  const evidence =
    typeof row.evidence === "string"
      ? JSON.parse(row.evidence as string)
      : Array.isArray(row.evidence)
        ? row.evidence
        : [];
  const captureContext =
    typeof row.capture_context === "string"
      ? JSON.parse(row.capture_context as string)
      : row.capture_context ?? null;

  return {
    id: row.id,
    type: row.type,
    text: row.text,
    scope: row.scope,
    path_scope: row.path_scope,
    repo: row.repo,
    status: row.status,
    confidence: row.confidence,
    source: row.source,
    evidence: evidence as EvidenceEntry[],
    capture_context: captureContext as MemoryItem["capture_context"],
    supersedes: row.supersedes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_validated_at: row.last_validated_at,
    last_injected_at: row.last_injected_at,
    injection_count: row.injection_count,
    override_count: row.override_count,
    repetition_count: row.repetition_count,
    auto_inject: row.auto_inject,
  };
}
