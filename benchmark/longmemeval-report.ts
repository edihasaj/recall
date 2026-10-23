import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

export interface RetrievalMetrics {
  question_id: string;
  question_type: string;
  recall_any_at_5: number;
  recall_any_at_10: number;
  recall_any_at_20: number;
  ndcg_at_10: number;
  mrr: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  entries: number;
}

export interface RunMetadata {
  selected_question_ids: string[];
  dataset_sha256: string;
  harness_sha256: string;
  runtime: { node_version: string; platform: string; arch: string };
  cache_embeddings: boolean;
  provenance: RunProvenance;
}

export interface RunProvenance {
  source_files_sha256: Record<string, string>;
  source_manifest_sha256: string;
  runtime_assets_sha256: string;
  package_lock_sha256: string;
  effective_env: Record<string, string | null>;
  synonym_override?: { path: string; sha256: string | null; status: "readable" | "unreadable_or_missing" };
}

export interface ProviderMetadata {
  provider: string;
  model: string;
  dimensions: number;
  index_dimensions: number;
  version: string;
}

export interface ResolvedEmbeddingConfig extends ProviderMetadata {
  similarity_threshold: number;
}

const ALLOWLISTED_ENV = [
  "RECALL_EMBEDDINGS_DISABLED",
  "RECALL_EMBEDDING_PROVIDER",
  "RECALL_EMBEDDING_MODEL",
  "RECALL_EMBEDDING_DIMS",
  "RECALL_EMBEDDING_VERSION",
  "RECALL_HYBRID_MIN_SIM",
  "RECALL_SIMILARITY_THRESHOLD",
  "RECALL_FTS_MODE",
  "RECALL_FTS_PREFIX",
  "RECALL_SYNONYMS",
  "RECALL_SYNONYMS_PATH",
  "RECALL_FUSION",
  "RECALL_RRF_K",
  "RECALL_RRF_LEX_WEIGHT",
  "RECALL_RRF_VEC_WEIGHT",
  "RECALL_LEX_WEIGHT",
  "RECALL_VEC_WEIGHT",
  "RECALL_HYDE",
  "RECALL_HYDE_MODEL",
  "RECALL_RERANK",
  "RECALL_RERANK_MODEL",
  "RECALL_RERANK_MAX_LENGTH",
  "RECALL_RERANK_MIN_SCORE",
  "RECALL_RERANK_CANDIDATE_MIN_SIM",
  "RECALL_RERANK_FTS_MODE",
  "RECALL_RERANK_TOP_K",
  "RECALL_RELEVANCE_LLM",
  "RECALL_RELEVANCE_LLM_CANDIDATES",
  "RECALL_RELEVANCE_LLM_MIN_GRADE",
  "RECALL_RELEVANCE_LLM_TIMEOUT_MS",
];

export function collectRunProvenance(repoRoot: string, env: NodeJS.ProcessEnv): RunProvenance {
  const sourcePaths = walkRuntimeSources(join(repoRoot, "src"), repoRoot);
  const benchmarkPaths = [
    "benchmark/longmemeval.ts",
    "benchmark/document-embedding-cache.ts",
    "benchmark/longmemeval-report.ts",
    "benchmark/longmemeval-source-identity.ts",
  ];
  const source_files_sha256 = Object.fromEntries(
    [...sourcePaths, ...benchmarkPaths]
      .sort()
      .map((path) => [path, hashFile(join(repoRoot, path))]),
  );
  const effective_env = Object.fromEntries(
    ALLOWLISTED_ENV.map((key) => [key, env[key] ?? null]),
  );
  const synonym_override = synonymOverride(env);
  const manifest = JSON.stringify(Object.entries(source_files_sha256));
  return {
    source_files_sha256,
    source_manifest_sha256: sha256(manifest),
    runtime_assets_sha256: sha256(JSON.stringify({ source_files_sha256, synonym_override })),
    package_lock_sha256: hashFile(join(repoRoot, "package-lock.json")),
    effective_env,
    ...(synonym_override ? { synonym_override } : {}),
  };
}

export function summarizeRetrieval(
  results: readonly RetrievalMetrics[],
  provider: ProviderMetadata,
  cache_embeddings: boolean,
  cache: CacheStats,
  total_seconds: number,
) {
  const mean = (key: keyof RetrievalMetrics) =>
    (results.reduce((sum, result) => sum + (result[key] as number), 0) / results.length) * 100;
  const byType = new Map<string, RetrievalMetrics[]>();
  for (const result of results) {
    const list = byType.get(result.question_type) ?? [];
    list.push(result);
    byType.set(result.question_type, list);
  }
  return {
    summary: {
      questions: results.length,
      embedding_provider: provider.provider,
      embedding_model: provider.model,
      cache_embeddings,
      cache,
      recall_any_at_5: mean("recall_any_at_5"),
      recall_any_at_10: mean("recall_any_at_10"),
      recall_any_at_20: mean("recall_any_at_20"),
      ndcg_at_10: mean("ndcg_at_10"),
      mrr: mean("mrr"),
      total_seconds,
    },
    by_type: Object.fromEntries(byType),
  };
}

/**
 * Reserves each output path with `wx` before model/provider setup. The final
 * JSON starts as status=running, so answer harnesses reject interrupted runs.
 */
export class LongMemEvalReporter {
  private readonly paths: { out: string; jsonl: string; progress: string } | undefined;
  private provider: ProviderMetadata | undefined;
  private resolvedConfig: ResolvedEmbeddingConfig | undefined;
  private lastQuestionId: string | undefined;

  constructor(
    out: string | undefined,
    private readonly metadata: RunMetadata,
    private cache: CacheStats,
  ) {
    if (!out) return;
    this.paths = { out, jsonl: `${out}.jsonl`, progress: `${out}.progress.json` };
    const existing = Object.values(this.paths).find((path) => existsSync(path));
    if (existing) throw new Error(`Output already exists: ${existing}`);
    this.writeNew(this.paths.out, this.running(0, 0));
    this.writeNew(this.paths.jsonl, "");
    this.writeNew(this.paths.progress, this.running(0, 0));
  }

  setProvider(provider: ProviderMetadata, resolvedConfig: ResolvedEmbeddingConfig): void {
    this.provider = provider;
    this.resolvedConfig = resolvedConfig;
    this.writeRunning(0, 0);
  }

  record(
    result: { question_id: string },
    completed: number,
    sourceCount: number,
    cache: CacheStats,
  ): void {
    if (!this.paths) return;
    this.cache = cache;
    this.lastQuestionId = result.question_id;
    appendFileSync(this.paths.jsonl, `${JSON.stringify(result)}\n`);
    this.writeRunning(completed, sourceCount);
  }

  complete(
    completed: Record<string, unknown>,
    sourceCount: number,
    cache: CacheStats,
  ): void {
    if (!this.paths) return;
    this.cache = cache;
    writeFileSync(this.paths.out, JSON.stringify(completed, null, 2));
    writeFileSync(this.paths.progress, JSON.stringify({
      ...this.running(this.metadata.selected_question_ids.length, sourceCount),
      status: "complete",
    }, null, 2));
  }

  private running(completed: number, sourceCount: number) {
    return {
      status: "running",
      selected_question_ids: this.metadata.selected_question_ids,
      dataset_sha256: this.metadata.dataset_sha256,
      harness_sha256: this.metadata.harness_sha256,
      runtime: this.metadata.runtime,
      provenance: this.metadata.provenance,
      ...(this.provider ? { local_provider: this.provider } : {}),
      ...(this.resolvedConfig ? { resolved_embedding_config: this.resolvedConfig } : {}),
      completed_questions: completed,
      planned_questions: this.metadata.selected_question_ids.length,
      source_count: sourceCount,
      ...(this.lastQuestionId ? { last_question_id: this.lastQuestionId } : {}),
      cache_embeddings: { enabled: this.metadata.cache_embeddings, stats: this.cache },
    };
  }

  private writeRunning(completed: number, sourceCount: number): void {
    if (!this.paths) return;
    const value = JSON.stringify(this.running(completed, sourceCount), null, 2);
    writeFileSync(this.paths.out, value);
    writeFileSync(this.paths.progress, value);
  }

  private writeNew(path: string, value: string | Record<string, unknown>): void {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    try {
      writeFileSync(path, text, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Output already exists: ${path}`);
      }
      throw error;
    }
  }
}

function walkRuntimeSources(dir: string, repoRoot: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walkRuntimeSources(path, repoRoot);
    return entry.isFile() && [".ts", ".json", ".sql"].some((extension) => entry.name.endsWith(extension))
      ? [relative(repoRoot, path).replaceAll("\\", "/")]
      : [];
  });
}

function synonymOverride(env: NodeJS.ProcessEnv): RunProvenance["synonym_override"] {
  const path = env.RECALL_SYNONYMS_PATH;
  if (!path) return undefined;
  try {
    return { path, sha256: sha256(readFileSync(path)), status: "readable" };
  } catch {
    return { path, sha256: null, status: "unreadable_or_missing" };
  }
}

function hashFile(path: string): string {
  return sha256(readFileSync(path));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
