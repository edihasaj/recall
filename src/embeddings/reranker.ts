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
 * The cutoff for injecting a re-ranked memory is per model; see rerankMinScore.
 *
 * The model is read directly rather than through the text-classification
 * pipeline: these models have a single output, and the pipeline's softmax
 * over one label returned 1.0 for every pair, so re-ranking kept the fused
 * order and flattened every score to 1.
 *
 * The reranker is loaded lazily on first use; consecutive calls reuse it.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";
import { getEmbeddingCacheRoot } from "./cache.js";
import { tokenizeRerankPairs } from "./tokenize-pairs.js";

const DEFAULT_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
const DEFAULT_TOP_K = 50;
const DEFAULT_MAX_LENGTH = 256;
const BATCH_SIZE = 16;

type Reranker = { tokenizer: PreTrainedTokenizer; model: PreTrainedModel; batchSize: number };
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
  let batchSize = BATCH_SIZE;
  if (isAbsolute(model)) {
    try {
      const value: unknown = JSON.parse(readFileSync(join(model, "config.json"), "utf8")).recall_rerank_batch_size;
      if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 64) batchSize = value;
    } catch {
      // A missing or invalid optional setting uses the default.
    }
  }
  return { tokenizer, model: classifier, batchSize };
}

export function isRerankerEnabled(): boolean {
  return process.env.RECALL_RERANK === "true";
}

// Re-rankers put probabilities on very different scales, so the injection
// cutoff belongs to the model. ms-marco scores correct coding memories
// around 1e-4 to 1e-1; 0.0003 kept 43% of them and fired on none of the
// controls in benchmark/data (see docs/configuration.md).
const DEFAULT_MIN_SCORES: Record<string, number> = { [DEFAULT_MODEL]: 0.0003 };
const FALLBACK_MIN_SCORE = 0.5;
// A cutoff by store size: [memories, cutoff] points sorted by size.
type MinScoreCurve = Array<[number, number]>;
const configMinScores = new Map<string, number | MinScoreCurve | null>();
const configCompanionRatios = new Map<string, number>();

/** Optional local-pack gate: a companion must score this fraction of the first selected memory. */
export function rerankCompanionRatio(): number {
  const model = rerankerModel();
  if (!isAbsolute(model)) return 0;
  if (!configCompanionRatios.has(model)) {
    let ratio = 0;
    try {
      const value: unknown = JSON.parse(readFileSync(join(model, "config.json"), "utf8")).recall_rerank_companion_ratio;
      if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) ratio = value;
    } catch {
      // Missing or invalid optional settings keep the existing selection policy.
    }
    configCompanionRatios.set(model, ratio);
  }
  return configCompanionRatios.get(model) ?? 0;
}

function asProbability(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

/**
 * A local model directory may declare `recall_rerank_min_score` in its
 * config.json: one probability, or an object from store size to cutoff
 * ({"180": 0.69, "1000": 0.855}). A pointwise score faces more near-misses as
 * the store grows, so a cutoff that keeps false injections rare at 180
 * memories lets many through at 2,000; the curve raises it with size.
 */
function configMinScore(model: string): number | MinScoreCurve | null {
  if (!isAbsolute(model)) return null;
  if (!configMinScores.has(model)) {
    let value: number | MinScoreCurve | null = null;
    try {
      value = parseMinScore(JSON.parse(readFileSync(join(model, "config.json"), "utf8")).recall_rerank_min_score);
    } catch {
      value = null;
    }
    configMinScores.set(model, value);
  }
  return configMinScores.get(model) ?? null;
}

function parseMinScore(value: unknown): number | MinScoreCurve | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return asProbability(value);
  const curve: MinScoreCurve = [];
  for (const [size, score] of Object.entries(value as Record<string, unknown>)) {
    const n = Number(size), p = asProbability(score);
    if (!Number.isFinite(n) || n < 1 || p === null) return null;
    curve.push([n, p]);
  }
  return curve.length ? curve.sort((a, b) => a[0] - b[0]) : null;
}

/** Linear in log(store size) between the points; flat beyond the ends. */
function cutoffAt(curve: MinScoreCurve, storeSize: number): number {
  const size = Math.max(1, storeSize);
  if (size <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [n0, p0] = curve[i - 1], [n1, p1] = curve[i];
    if (size <= n1) return p0 + ((p1 - p0) * Math.log(size / n0)) / Math.log(n1 / n0);
  }
  return curve[curve.length - 1][1];
}

/**
 * The least relevance probability at which a re-ranked memory may be
 * injected without also clearing the vector-similarity floor: the
 * RECALL_RERANK_MIN_SCORE override, else the model's own default (its
 * config.json, or the built-in value for the default model), else 0.5.
 * `storeSize` is the number of memories the query could inject; it only
 * matters for a model whose config gives a cutoff by store size.
 */
export function rerankMinScore(storeSize = 0): number {
  const model = rerankerModel();
  const override = asProbability(process.env.RECALL_RERANK_MIN_SCORE);
  if (override !== null) return override;
  const configured = configMinScore(model);
  if (Array.isArray(configured)) return cutoffAt(configured, storeSize);
  return configured ?? DEFAULT_MIN_SCORES[model] ?? FALLBACK_MIN_SCORE;
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

/** Keyword-arm join while re-ranking: RECALL_RERANK_FTS_MODE, default "or". */
export function rerankFtsMode(): "and" | "or" {
  return process.env.RECALL_RERANK_FTS_MODE === "and" ? "and" : "or";
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
  const { tokenizer, model, batchSize } = await rerankerPromise;
  const scores: number[] = [];
  for (let start = 0; start < documents.length; start += batchSize) {
    const batch = documents.slice(start, start + batchSize);
    const inputs = tokenizeRerankPairs(tokenizer, query, batch, maxLength());
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
  configCompanionRatios.clear();
}

// Test helper: replace the model with a deterministic scorer (null restores it).
export function setRerankScorerForTests(scorer: PairScorer | null): void {
  scorerOverride = scorer;
}
