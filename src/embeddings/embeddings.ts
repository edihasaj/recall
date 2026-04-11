/**
 * Optional embeddings module — feature-gated behind config.
 * Provides semantic search and dedup via cosine similarity.
 * Supports OpenAI text-embedding-3-small (default).
 */

import { eq } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { memories } from "../db/schema.js";
import type { EmbeddingConfig, MemoryItem } from "../types.js";

// --- Embedding generation ---

export async function generateEmbedding(
  text: string,
  config: EmbeddingConfig,
): Promise<Float32Array> {
  if (config.provider === "openai") {
    return generateOpenAIEmbedding(text, config);
  }
  throw new Error(`Unsupported embedding provider: ${config.provider}`);
}

async function generateOpenAIEmbedding(
  text: string,
  config: EmbeddingConfig,
): Promise<Float32Array> {
  const apiKey = config.api_key ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OpenAI API key required for embeddings");

  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: text,
      model: config.model,
      dimensions: config.dimensions,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI embedding failed: ${err}`);
  }

  const data = (await resp.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  return new Float32Array(data.data[0].embedding);
}

// --- Batch embedding ---

export async function generateEmbeddings(
  texts: string[],
  config: EmbeddingConfig,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const apiKey = config.api_key ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OpenAI API key required for embeddings");

  // OpenAI supports batch input
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: texts,
      model: config.model,
      dimensions: config.dimensions,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI embedding failed: ${err}`);
  }

  const data = (await resp.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
  };

  // Sort by index to maintain order
  const sorted = data.data.sort((a, b) => a.index - b.index);
  return sorted.map((d) => new Float32Array(d.embedding));
}

// --- Store embedding ---

export function storeEmbedding(
  db: RecallDb,
  memoryId: string,
  embedding: Float32Array,
) {
  const buffer = Buffer.from(embedding.buffer);
  db.update(memories)
    .set({ embedding: buffer })
    .where(eq(memories.id, memoryId))
    .run();
}

// --- Load embedding ---

export function loadEmbedding(
  db: RecallDb,
  memoryId: string,
): Float32Array | null {
  const row = db
    .select({ embedding: memories.embedding })
    .from(memories)
    .where(eq(memories.id, memoryId))
    .get();

  if (!row?.embedding) return null;
  return new Float32Array(
    (row.embedding as Buffer).buffer,
    (row.embedding as Buffer).byteOffset,
    (row.embedding as Buffer).byteLength / 4,
  );
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
  const queryEmbedding = await generateEmbedding(query, config);
  const limit = options.limit ?? 10;

  // Load all memories with embeddings
  const rows = db.select().from(memories).all();

  const results: Array<{ memory: any; similarity: number }> = [];

  for (const row of rows) {
    if (!row.embedding) continue;
    if (options.repo && row.repo !== options.repo) continue;
    if (row.status === "rejected") continue;

    const emb = new Float32Array(
      (row.embedding as Buffer).buffer,
      (row.embedding as Buffer).byteOffset,
      (row.embedding as Buffer).byteLength / 4,
    );

    const sim = cosineSimilarity(queryEmbedding, emb);
    if (sim >= config.similarity_threshold) {
      results.push({
        memory: {
          ...row,
          evidence:
            typeof row.evidence === "string"
              ? JSON.parse(row.evidence as string)
              : row.evidence,
        },
        similarity: sim,
      });
    }
  }

  return results
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

// --- Semantic dedup ---

export async function findSemanticDuplicates(
  db: RecallDb,
  text: string,
  config: EmbeddingConfig,
  threshold?: number,
): Promise<Array<{ id: string; text: string; similarity: number }>> {
  const queryEmbedding = await generateEmbedding(text, config);
  const dupThreshold = threshold ?? config.similarity_threshold;

  const rows = db.select().from(memories).all();
  const duplicates: Array<{ id: string; text: string; similarity: number }> = [];

  for (const row of rows) {
    if (!row.embedding) continue;
    if (row.status === "rejected") continue;

    const emb = new Float32Array(
      (row.embedding as Buffer).buffer,
      (row.embedding as Buffer).byteOffset,
      (row.embedding as Buffer).byteLength / 4,
    );

    const sim = cosineSimilarity(queryEmbedding, emb);
    if (sim >= dupThreshold) {
      duplicates.push({ id: row.id, text: row.text, similarity: sim });
    }
  }

  return duplicates.sort((a, b) => b.similarity - a.similarity);
}

// --- Embed all un-embedded memories ---

export async function embedAllMemories(
  db: RecallDb,
  config: EmbeddingConfig,
): Promise<number> {
  const rows = db
    .select({ id: memories.id, text: memories.text, embedding: memories.embedding })
    .from(memories)
    .all();

  const unembedded = rows.filter((r) => !r.embedding);
  if (unembedded.length === 0) return 0;

  // Batch in chunks of 100
  const BATCH_SIZE = 100;
  let total = 0;

  for (let i = 0; i < unembedded.length; i += BATCH_SIZE) {
    const batch = unembedded.slice(i, i + BATCH_SIZE);
    const texts = batch.map((r) => r.text);
    const embeddings = await generateEmbeddings(texts, config);

    for (let j = 0; j < batch.length; j++) {
      storeEmbedding(db, batch[j].id, embeddings[j]);
      total++;
    }
  }

  return total;
}
