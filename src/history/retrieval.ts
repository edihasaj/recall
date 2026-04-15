import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { historySnippetEmbeddings, historySnippets } from "../db/schema.js";
import type { EmbeddingConfig, HistorySnippet } from "../types.js";
import { generateEmbedding, generateEmbeddings, loadEmbeddingConfigFromEnv } from "../embeddings/embeddings.js";
import {
  rebuildHistoryVecIndex,
  removeHistoryVecRow,
  searchHistoryVecIndex,
  upsertHistoryVecRow,
  verifyHistoryVecIndex,
} from "../vector/sqlite-vec-history.js";
import {
  rebuildHistoryFtsIndex,
  searchHistoryFtsIndex,
  syncHistoryFtsIndex,
  verifyHistoryFtsIndex,
} from "../vector/sqlite-fts-history.js";

type HistorySnippetRow = typeof historySnippets.$inferSelect;
type HistorySnippetEmbeddingRow = typeof historySnippetEmbeddings.$inferSelect;

function hashText(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function version(config: EmbeddingConfig) {
  return config.version || `${config.provider}:${config.model}:${config.dimensions}`;
}

function rowNeedsRefresh(
  row: Pick<HistorySnippetRow, "text">,
  existing: HistorySnippetEmbeddingRow | undefined,
  config: EmbeddingConfig,
) {
  if (!existing) return true;
  return (
    existing.model !== config.model ||
    existing.dimensions !== config.dimensions ||
    existing.version !== version(config) ||
    existing.content_hash !== hashText(row.text)
  );
}

function deserializeEmbedding(buffer: Buffer): Float32Array {
  return new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
}

function rowToHistorySnippet(row: HistorySnippetRow): HistorySnippet {
  const sourceActivityIds =
    typeof row.source_activity_ids === "string"
      ? JSON.parse(row.source_activity_ids)
      : Array.isArray(row.source_activity_ids)
        ? row.source_activity_ids
        : [];
  return {
    id: row.id,
    repo: row.repo,
    session_id: row.session_id,
    kind: row.kind,
    text: row.text,
    source_activity_ids: sourceActivityIds,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function storeHistoryEmbedding(
  db: RecallDb,
  snippetId: string,
  text: string,
  embedding: Float32Array,
  config: EmbeddingConfig,
) {
  const now = new Date().toISOString();
  const payload = {
    snippet_id: snippetId,
    model: config.model,
    dimensions: config.dimensions,
    version: version(config),
    content_hash: hashText(text),
    updated_at: now,
    embedding: Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
  };

  db.insert(historySnippetEmbeddings)
    .values(payload)
    .onConflictDoUpdate({
      target: historySnippetEmbeddings.snippet_id,
      set: {
        model: payload.model,
        dimensions: payload.dimensions,
        version: payload.version,
        content_hash: payload.content_hash,
        updated_at: payload.updated_at,
        embedding: payload.embedding,
      },
    })
    .run();
}

export function loadHistoryEmbedding(
  db: RecallDb,
  snippetId: string,
): Float32Array | null {
  const row = db.select({ embedding: historySnippetEmbeddings.embedding })
    .from(historySnippetEmbeddings)
    .where(eq(historySnippetEmbeddings.snippet_id, snippetId))
    .get();
  return row?.embedding ? deserializeEmbedding(row.embedding as Buffer) : null;
}

export function removeStoredHistoryEmbedding(
  db: RecallDb,
  snippetId: string,
) {
  return db.delete(historySnippetEmbeddings)
    .where(eq(historySnippetEmbeddings.snippet_id, snippetId))
    .run().changes > 0;
}

export async function syncHistorySnippetEmbedding(
  db: RecallDb,
  snippetId: string,
  config: EmbeddingConfig,
): Promise<"stored" | "updated" | "removed" | "skipped"> {
  const snippet = db.select().from(historySnippets)
    .where(eq(historySnippets.id, snippetId))
    .get();

  syncHistoryFtsIndex(db, snippetId);
  if (!snippet) {
    removeStoredHistoryEmbedding(db, snippetId);
    removeHistoryVecRow(db, snippetId);
    return "removed";
  }

  const existing = db.select().from(historySnippetEmbeddings)
    .where(eq(historySnippetEmbeddings.snippet_id, snippetId))
    .get();

  if (!rowNeedsRefresh(snippet, existing, config)) {
    if (existing) upsertHistoryVecRow(db, snippet, existing, config);
    return "skipped";
  }

  const embedding = await generateEmbedding(snippet.text, config);
  storeHistoryEmbedding(db, snippet.id, snippet.text, embedding, config);
  const refreshed = db.select().from(historySnippetEmbeddings)
    .where(eq(historySnippetEmbeddings.snippet_id, snippet.id))
    .get();
  if (!refreshed) throw new Error(`Failed to reload history embedding row for ${snippet.id}`);
  upsertHistoryVecRow(db, snippet, refreshed, config);
  return existing ? "updated" : "stored";
}

export async function bootstrapHistoryEmbeddings(
  db: RecallDb,
  config: EmbeddingConfig,
  options: { repo?: string } = {},
) {
  const rows = db.select().from(historySnippets).all()
    .filter((row) => !options.repo || row.repo === options.repo);
  const existing = new Map(
    db.select().from(historySnippetEmbeddings).all().map((row) => [row.snippet_id, row]),
  );

  const pending = rows.filter((row) => rowNeedsRefresh(row, existing.get(row.id), config));

  for (const row of rows) {
    syncHistoryFtsIndex(db, row.id);
  }

  const BATCH_SIZE = 100;
  let total = 0;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const embeddings = await generateEmbeddings(batch.map((row) => row.text), config);
    for (let j = 0; j < batch.length; j++) {
      storeHistoryEmbedding(db, batch[j].id, batch[j].text, embeddings[j], config);
      total++;
    }
  }

  rebuildHistoryFtsIndex(db, options);
  rebuildHistoryVecIndex(db, config, options);
  return total;
}

export function verifyHistoryEmbeddings(
  db: RecallDb,
  config: EmbeddingConfig,
  options: { repo?: string } = {},
) {
  const rows = db.select().from(historySnippets).all()
    .filter((row) => !options.repo || row.repo === options.repo);
  const embeddings = db.select().from(historySnippetEmbeddings).all();
  const byId = new Map(embeddings.map((row) => [row.snippet_id, row]));

  let eligible = 0;
  let stale = 0;
  for (const row of rows) {
    eligible++;
    if (rowNeedsRefresh(row, byId.get(row.id), config)) stale++;
  }

  const vec = verifyHistoryVecIndex(db, options);
  const fts = verifyHistoryFtsIndex(db, options);

  return {
    eligible,
    stored: embeddings.filter((row) => {
      if (!options.repo) return true;
      const snippet = rows.find((item) => item.id === row.snippet_id);
      return snippet?.repo === options.repo;
    }).length,
    stale,
    indexed: vec.indexed,
    index_drift: vec.drift,
    lexical_indexed: fts.indexed,
    lexical_drift: fts.drift,
  };
}

function lexicalRankToScore(rank: number, position: number) {
  const safeRank = Number.isFinite(rank) ? Math.abs(rank) : position + 1;
  return 1 / (1 + safeRank + position);
}

export async function searchHistorySnippets(
  db: RecallDb,
  query: string,
  options: { repo?: string; limit?: number } = {},
) {
  const limit = options.limit ?? 10;
  const lexicalMatches = searchHistoryFtsIndex(db, query, {
    repo: options.repo,
    limit: Math.max(limit * 2, 20),
  });

  const config = loadEmbeddingConfigFromEnv();
  const vectorMatches = config?.enabled
    ? searchHistoryVecIndex(db, await generateEmbedding(query, config), {
        repo: options.repo,
        limit: Math.max(limit * 2, 20),
      })
    : [];

  const rowsById = new Map(
    db.select().from(historySnippets).all().map((row) => [row.id, row]),
  );

  const merged = new Map<string, {
    snippet: HistorySnippet;
    score: number;
    similarity: number;
    lexical_score: number;
  }>();

  for (let i = 0; i < lexicalMatches.length; i++) {
    const match = lexicalMatches[i];
    const row = rowsById.get(match.snippet_id);
    if (!row) continue;
    const lexicalScore = lexicalRankToScore(match.lexical_rank, i);
    merged.set(match.snippet_id, {
      snippet: rowToHistorySnippet(row),
      score: lexicalScore * 0.35,
      similarity: 0,
      lexical_score: lexicalScore,
    });
  }

  for (const match of vectorMatches) {
    const row = rowsById.get(match.snippet_id);
    if (!row) continue;
    const similarity = Math.max(0, 1 - match.distance);
    const existing = merged.get(match.snippet_id);
    if (existing) {
      existing.similarity = similarity;
      existing.score = similarity * 0.65 + existing.lexical_score * 0.35;
    } else {
      merged.set(match.snippet_id, {
        snippet: rowToHistorySnippet(row),
        score: similarity * 0.65,
        similarity,
        lexical_score: 0,
      });
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
