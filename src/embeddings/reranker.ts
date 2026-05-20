/**
 * Cross-encoder re-ranking for hybridSearch.
 *
 * Hybrid (BM25 ∪ cosine) gets close; a cross-encoder reads each
 * (query, document) pair jointly and scores relevance directly,
 * which usually adds +10–20 pp R@5 on top of any hybrid baseline.
 *
 * Gated behind RECALL_RERANK=true (default off). Model defaults to
 * Xenova/ms-marco-MiniLM-L-6-v2 (~25 MB, q8 quantized). Adds ~10 ms
 * per pair on CPU — fine for SessionStart, gate for hot paths.
 *
 * The reranker is loaded lazily on first use; consecutive calls reuse
 * the same pipeline instance.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  pipeline,
  type TextClassificationPipeline,
} from "@huggingface/transformers";
import { getEmbeddingCacheRoot } from "./cache.js";

const DEFAULT_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
const DEFAULT_TOP_K = 50;

let rerankerPromise: Promise<TextClassificationPipeline> | null = null;

function getModel(): string {
  return process.env.RECALL_RERANK_MODEL?.trim() || DEFAULT_MODEL;
}

async function getReranker(): Promise<TextClassificationPipeline> {
  const model = getModel();
  // Use the shared embedding cache root with a "rerank" subdir; the
  // EmbeddingConfig provider enum doesn't include rerankers so we can't go
  // through ensureEmbeddingCachePath without widening that union.
  const cacheDir = join(getEmbeddingCacheRoot(), "rerank", ...model.split("/"));
  mkdirSync(cacheDir, { recursive: true });
  rerankerPromise ??= pipeline("text-classification", model, {
    cache_dir: cacheDir,
    dtype: "q8",
  }) as Promise<TextClassificationPipeline>;
  return rerankerPromise;
}

export function isRerankerEnabled(): boolean {
  return process.env.RECALL_RERANK === "true";
}

export function rerankerTopK(): number {
  const env = process.env.RECALL_RERANK_TOP_K;
  if (!env) return DEFAULT_TOP_K;
  const parsed = Number.parseInt(env, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOP_K;
}

/**
 * Score (query, document) pairs with the cross-encoder. Returns an
 * array of scores, one per pair, in the same order as the input.
 * Throws if the reranker fails to load; callers should catch and fall
 * back to the un-reranked order.
 */
export async function rerankPairs(
  query: string,
  documents: string[],
): Promise<number[]> {
  if (documents.length === 0) return [];
  const reranker = await getReranker();
  // transformers.js text-classification pipeline accepts {text, text_pair}
  // shapes for sentence-pair classification (cross-encoders). The output
  // is one {label, score} per pair.
  const pairs = documents.map((doc) => ({ text: query, text_pair: doc }));
  const results = (await reranker(pairs as unknown as string[])) as unknown as
    | Array<{ score: number }>
    | Array<Array<{ score: number }>>;
  // Single-pair pipelines return one object; batches return arrays of arrays
  // depending on the model's head. Normalize to a flat number[].
  return documents.map((_, i) => {
    const slot = (results as unknown as Array<unknown>)[i];
    if (Array.isArray(slot)) {
      return (slot[0] as { score: number })?.score ?? 0;
    }
    return (slot as { score: number })?.score ?? 0;
  });
}

// Test helper: discard the cached pipeline so a fresh env knob takes effect.
export function resetRerankerCache(): void {
  rerankerPromise = null;
}
