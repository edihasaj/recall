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

type MemoryRow = typeof memories.$inferSelect;
type MemoryEmbeddingRow = typeof memoryEmbeddings.$inferSelect;

const EMBEDDING_BATCH_SIZE = 100;
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
} as const;

// --- Config ---

export function loadEmbeddingConfigFromEnv(): EmbeddingConfig | null {
  if (process.env.RECALL_EMBEDDINGS_DISABLED === "true") return null;
  const provider = process.env.RECALL_EMBEDDING_PROVIDER === "multilingual-e5"
    ? "multilingual-e5"
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

function shouldEmbedMemory(row: Pick<MemoryRow, "status" | "confidence">): boolean {
  if (row.status === "rejected" || row.status === "transient") return false;
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
      console.error(`[recall] embedding sync failed for ${memoryId.slice(0, 8)}: ${message}`);
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

  const lexicalMatches = searchMemoryFtsIndex(db, query, {
    repo: options.repo,
    limit: Math.max(limit * 2, 20),
  });
  const semanticMatches = config
    ? searchMemoryVecIndex(
        db,
        projectEmbeddingToIndex(
          await generateEmbedding(query, config, "query"),
          resolveProvider(config).metadata().index_dimensions,
        ),
        { repo: options.repo, limit: Math.max(limit * 2, 20) },
      )
    : [];

  const rowsById = new Map(
    db.select().from(memories).all().map((row) => [row.id, row]),
  );

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
    merged.set(match.memory_id, {
      memory: rowToMemory(row),
      similarity: 0,
      lexical_score: lexicalScore,
      score: lexicalScore * 0.35,
    });
  }

  for (const match of semanticMatches) {
    const row = rowsById.get(match.memory_id);
    if (!row || !shouldEmbedMemory(row)) continue;

    const similarity = Math.max(0, 1 - match.distance);
    const existing = merged.get(match.memory_id);
    if (existing) {
      existing.similarity = similarity;
      existing.score = (similarity * 0.65) + (existing.lexical_score * 0.35);
    } else {
      merged.set(match.memory_id, {
        memory: rowToMemory(row),
        similarity,
        lexical_score: 0,
        score: similarity * 0.65,
      });
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
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
  };
}
