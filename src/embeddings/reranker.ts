/**
 * Cross-encoder re-ranking for hybridSearch.
 *
 * Hybrid (BM25 ∪ cosine) gets close; a cross-encoder reads each
 * (query, document) pair jointly and scores relevance directly, which is
 * what catches a memory that matters without sharing words with the query.
 *
 * Gated behind RECALL_RERANK=true (default off). Model defaults to
 * Xenova/ms-marco-MiniLM-L-6-v2 (~25 MB, q8). RECALL_RERANK_MODEL takes a
 * Hugging Face id or an absolute path to a local model directory (config,
 * tokenizer and onnx/model_quantized.onnx), such as a relevance model trained
 * for memories. Pairs are cut at RECALL_RERANK_MAX_LENGTH tokens (default 256).
 *
 * The model is read directly rather than through the text-classification
 * pipeline: these models have a single output, and the pipeline's softmax
 * over one label returned 1.0 for every pair, so re-ranking kept the fused
 * order and flattened every score to 1.
 *
 * The reranker is loaded lazily on first use; consecutive calls reuse it.
 */
import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";
import { getEmbeddingCacheRoot } from "./cache.js";

const DEFAULT_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
const DEFAULT_TOP_K = 50;
const DEFAULT_MAX_LENGTH = 256;
const BATCH_SIZE = 16;

type Reranker = { tokenizer: PreTrainedTokenizer; model: PreTrainedModel };
export type PairScorer = (query: string, documents: string[]) => Promise<number[]>;

let rerankerPromise: Promise<Reranker> | null = null;
let scorerOverride: PairScorer | null = null;

export function rerankerModel(): string {
  return process.env.RECALL_RERANK_MODEL?.trim() || DEFAULT_MODEL;
}

function maxLength(): number {
  const parsed = Number.parseInt(process.env.RECALL_RERANK_MAX_LENGTH ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_LENGTH;
}

async function loadReranker(model: string): Promise<Reranker> {
  // A local directory loads in place; a hub id is cached under the shared
  // embedding cache root in a "rerank" subdir.
  const options: { dtype: "q8"; cache_dir?: string } = { dtype: "q8" };
  if (!isAbsolute(model)) {
    const cacheDir = join(getEmbeddingCacheRoot(), "rerank", ...model.split("/"));
    mkdirSync(cacheDir, { recursive: true });
    options.cache_dir = cacheDir;
  }
  const [tokenizer, classifier] = await Promise.all([
    AutoTokenizer.from_pretrained(model, options.cache_dir ? { cache_dir: options.cache_dir } : {}),
    AutoModelForSequenceClassification.from_pretrained(model, options),
  ]);
  return { tokenizer, model: classifier };
}

export function isRerankerEnabled(): boolean {
  return process.env.RECALL_RERANK === "true";
}

/**
 * The least relevance probability at which a re-ranked memory may be
 * injected without also clearing the vector-similarity floor.
 * RECALL_RERANK_MIN_SCORE, default 0.5.
 */
export function rerankMinScore(): number {
  const parsed = Number.parseFloat(process.env.RECALL_RERANK_MIN_SCORE ?? "");
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.5;
}

/**
 * The vector-similarity floor for candidates when re-ranking is on.
 * RECALL_RERANK_CANDIDATE_MIN_SIM, default 0: the pool is already capped at
 * the top-K fused matches, and the re-ranker judges relevance.
 */
export function rerankCandidateMinSimilarity(): number {
  const parsed = Number.parseFloat(process.env.RECALL_RERANK_CANDIDATE_MIN_SIM ?? "");
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
}

export function rerankerTopK(): number {
  const env = process.env.RECALL_RERANK_TOP_K;
  if (!env) return DEFAULT_TOP_K;
  const parsed = Number.parseInt(env, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOP_K;
}

function sigmoid(logit: number): number {
  return 1 / (1 + Math.exp(-logit));
}

async function scoreWithModel(query: string, documents: string[]): Promise<number[]> {
  rerankerPromise ??= loadReranker(rerankerModel());
  const { tokenizer, model } = await rerankerPromise;
  const scores: number[] = [];
  for (let start = 0; start < documents.length; start += BATCH_SIZE) {
    const batch = documents.slice(start, start + BATCH_SIZE);
    const inputs = tokenizer(batch.map(() => query), {
      text_pair: batch,
      padding: true,
      truncation: true,
      max_length: maxLength(),
    });
    const { logits } = await model(inputs);
    // One output per pair: logits has shape [batch, 1].
    const columns = logits.dims.at(-1) ?? 1;
    for (let row = 0; row < batch.length; row++) {
      scores.push(sigmoid(Number(logits.data[row * columns])));
    }
  }
  return scores;
}

/**
 * Score (query, document) pairs with the cross-encoder. Returns one
 * relevance probability in [0, 1] per pair, in input order.
 * Throws if the reranker fails to load; callers should catch and fall
 * back to the un-reranked order.
 */
export async function rerankPairs(
  query: string,
  documents: string[],
): Promise<number[]> {
  if (documents.length === 0) return [];
  return (scorerOverride ?? scoreWithModel)(query, documents);
}

// Test helper: discard the cached model so a fresh env knob takes effect.
export function resetRerankerCache(): void {
  rerankerPromise = null;
}

// Test helper: replace the model with a deterministic scorer (null restores it).
export function setRerankScorerForTests(scorer: PairScorer | null): void {
  scorerOverride = scorer;
}
