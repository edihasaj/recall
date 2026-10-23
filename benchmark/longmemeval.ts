import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { initStandaloneDb } from "../src/db/client.js";
import {
  generateEmbedding,
  hybridSearch,
  loadEmbeddingConfigFromEnv,
  storeEmbedding,
  ensureEmbeddingProviderReady,
  projectEmbeddingToIndex,
} from "../src/embeddings/embeddings.js";
import { upsertMemoryVecRow, searchMemoryVecIndex } from "../src/vector/sqlite-vec.js";
import { upsertMemoryFtsRow, searchMemoryFtsIndex } from "../src/vector/sqlite-fts.js";
import { resolveProvider } from "../src/embeddings/providers/index.js";
import { getMemory } from "../src/models/memory.js";
import { normalizeQueryForRetrieval } from "../src/compiler/context.js";
import { memories } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { DocumentEmbeddingCache } from "./document-embedding-cache.js";
import { questionSourcesHash } from "./longmemeval-source-identity.js";
import { LongMemEvalReporter, collectRunProvenance, summarizeRetrieval, type CacheStats, type RetrievalMetrics } from "./longmemeval-report.js";
interface LongMemEvalEntry {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  answer_session_ids: string[];
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: Array<Array<{ role: string; content: string; has_answer?: boolean }>>;
}
interface BenchResult extends RetrievalMetrics {
  retrieved_session_ids: string[];
  retrieved_session_occurrences?: number[];
  source_sha256: string;
  gold_session_ids: string[];
  lex_rank_session_ids?: string[];
  vec_rank_session_ids?: string[];
}
const ABSTENTION_TYPES = new Set([
  "single-session-user_abs",
  "multi-session_abs",
  "knowledge-update_abs",
  "temporal-reasoning_abs",
]);

function turnsToText(turns: Array<{ role: string; content: string }>): string {
  return turns.map((t) => `${t.role}: ${t.content}`).join("\n");
}

function recallAny(retrieved: string[], gold: string[], k: number): number {
  const top = new Set(retrieved.slice(0, k));
  return gold.some((id) => top.has(id)) ? 1 : 0;
}

function dcg(rels: boolean[], k: number): number {
  let sum = 0;
  for (let i = 0; i < Math.min(k, rels.length); i++) {
    sum += (rels[i] ? 1 : 0) / Math.log2(i + 2);
  }
  return sum;
}

function ndcg(retrieved: string[], gold: Set<string>, k: number): number {
  const rels = retrieved.slice(0, k).map((id) => gold.has(id));
  const ideal = Array.from({ length: Math.min(k, gold.size) }, () => true);
  const idealDcg = dcg(ideal, k);
  return idealDcg === 0 ? 0 : dcg(rels, k) / idealDcg;
}

function mrr(retrieved: string[], gold: Set<string>): number {
  for (let i = 0; i < retrieved.length; i++) {
    if (gold.has(retrieved[i])) return 1 / (i + 1);
  }
  return 0;
}

interface Args {
  limit?: number;
  out?: string;
  quiet: boolean;
  stratify: boolean;
  dumpRaw: boolean;
  cacheEmbeddings: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { quiet: false, stratify: false, dumpRaw: false, cacheEmbeddings: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") out.limit = parseInt(argv[++i] ?? "0", 10);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--stratify") out.stratify = true;
    else if (a === "--dump-raw") out.dumpRaw = true;
    else if (a === "--cache-embeddings") out.cacheEmbeddings = true;
  }
  return out;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stratifySample<T extends { question_type: string }>(entries: T[], limit: number): T[] {
  const seed = parseInt(process.env.RECALL_STRATIFY_SEED ?? "42", 10);
  const rand = mulberry32(Number.isFinite(seed) ? seed : 42);
  const byType = new Map<string, T[]>();
  for (const e of entries) {
    const arr = byType.get(e.question_type) ?? [];
    arr.push(e);
    byType.set(e.question_type, arr);
  }
  for (const arr of byType.values()) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
  }
  const buckets = [...byType.values()];
  const picked: T[] = [];
  let idx = 0;
  while (picked.length < limit && buckets.some((b) => b.length > 0)) {
    const bucket = buckets[idx % buckets.length]!;
    const next = bucket.shift();
    if (next) picked.push(next);
    idx++;
  }
  return picked;
}

async function main() {
  const args = parseArgs(process.argv);

  const chatEnvDefaults: Record<string, string> = {
    RECALL_HYBRID_MIN_SIM: "0",
    RECALL_SIMILARITY_THRESHOLD: "0",
    RECALL_FTS_MODE: "or",
  };
  const appliedEnv: string[] = [];
  for (const [key, value] of Object.entries(chatEnvDefaults)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      appliedEnv.push(`${key}=${value}`);
    }
  }
  if (appliedEnv.length > 0) {
    console.log(`auto-applied chat-mode env: ${appliedEnv.join(", ")}`);
  }

  const datasetPath = fileURLToPath(
    new URL("./data/longmemeval_s_cleaned.json", import.meta.url),
  );
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  if (!existsSync(datasetPath)) {
    console.error(`Dataset not found: ${datasetPath}`);
    console.error("Download with:");
    console.error("  mkdir -p benchmark/data");
    console.error(
      "  curl -sL -o benchmark/data/longmemeval_s_cleaned.json \\",
    );
    console.error(
      "    https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json",
    );
    process.exit(1);
  }

  process.stdout.write(`loading dataset…`);
  const t0 = Date.now();
  const datasetText = readFileSync(datasetPath, "utf-8");
  const datasetSHA256 = hashText(datasetText);
  const harnessSHA256 = hashText(readFileSync(fileURLToPath(import.meta.url), "utf-8"));
  const provenance = collectRunProvenance(repoRoot, process.env);
  const raw = JSON.parse(datasetText) as LongMemEvalEntry[];
  process.stdout.write(` ${raw.length} entries in ${Date.now() - t0}ms\n`);

  let entries = raw.filter((e) => !ABSTENTION_TYPES.has(e.question_type));
  if (args.limit && args.limit < entries.length) {
    entries = args.stratify
      ? stratifySample(entries, args.limit)
      : entries.slice(0, args.limit);
  }
  console.log(
    `processing ${entries.length} retrieval questions ` +
      `(${raw.length - entries.length} not selected)` +
      (args.stratify ? " · stratified across types" : ""),
  );
  const reporter = new LongMemEvalReporter(args.out, {
    selected_question_ids: entries.map((entry) => entry.question_id),
    dataset_sha256: datasetSHA256,
    harness_sha256: harnessSHA256,
    runtime: {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    cache_embeddings: args.cacheEmbeddings,
    provenance,
  }, { hits: 0, misses: 0, entries: 0 });

  const embeddingConfig = loadEmbeddingConfigFromEnv();
  if (!embeddingConfig) {
    console.error(
      "no embedding provider — set RECALL_EMBEDDINGS_DISABLED=false (default) and " +
        "ensure nomic / multilingual-e5 model is cached. Run `recall embeddings setup` first.",
    );
    process.exit(1);
  }

  console.log(
    `embedding provider: ${embeddingConfig.provider} (${embeddingConfig.model})`,
  );
  const info = await ensureEmbeddingProviderReady(embeddingConfig);
  console.log(
    `dimensions: ${info?.dimensions} canonical / ${info?.index_dimensions} index`,
  );
  const providerMetadata = {
    provider: embeddingConfig.provider,
    model: embeddingConfig.model,
    dimensions: info?.dimensions ?? embeddingConfig.dimensions,
    index_dimensions: info?.index_dimensions ?? embeddingConfig.dimensions,
    version: embeddingConfig.version,
  };
  const resolvedEmbeddingConfig = {
    ...providerMetadata,
    similarity_threshold: embeddingConfig.similarity_threshold,
  };
  reporter.setProvider(providerMetadata, resolvedEmbeddingConfig);

  const tmp = mkdtempSync(join(tmpdir(), "recall-lme-"));
  const dbPath = join(tmp, "lme.db");
  const db = initStandaloneDb(dbPath);
  console.log(`temp db: ${dbPath}`);

  const results: BenchResult[] = [];
  const memToSession = new Map<string, string>();
  const memToOccurrence = new Map<string, number>();
  let lastSourceCount = 0;
  const documentCache = args.cacheEmbeddings
    ? new DocumentEmbeddingCache(
      { provider: embeddingConfig.provider, model: embeddingConfig.model },
      (text) => generateEmbedding(text, embeddingConfig, "document"),
    )
    : undefined;
  const startedAt = Date.now();

  for (let qi = 0; qi < entries.length; qi++) {
    const entry = entries[qi]!;
    const repo = `q_${qi}_${entry.question_id.slice(0, 8)}`;

    const seeded: string[] = [];
    const seedTexts: string[] = [];
    const sourceSessions: Array<{ id: string; date: string; text: string }> = [];
    if (
      entry.haystack_session_ids.length !== entry.haystack_sessions.length
      || entry.haystack_dates.length !== entry.haystack_sessions.length
    ) {
      throw new Error(`Invalid source shape for question ${entry.question_id}`);
    }
    const now = new Date().toISOString();
    for (let si = 0; si < entry.haystack_sessions.length; si++) {
      const sessionId = entry.haystack_session_ids[si]!;
      const date = entry.haystack_dates[si]!;
      const text = turnsToText(entry.haystack_sessions[si]!);
      const memoryId = randomUUID();
      db.insert(memories).values({
        id: memoryId,
        type: "rule",
        text,
        scope: "repo",
        path_scope: null,
        repo,
        status: "active",
        confidence: 0.9,
        source: "repo_scan",
        evidence: [] as any,
        capture_context: null,
        supersedes: null,
        dedupe_key: null,
        created_at: now,
        updated_at: now,
        last_validated_at: null,
        last_injected_at: null,
        injection_count: 0,
        override_count: 0,
        repetition_count: 0,
      }).run();
      seeded.push(memoryId);
      seedTexts.push(text);
      memToSession.set(memoryId, sessionId);
      memToOccurrence.set(memoryId, si);
      sourceSessions.push({ id: sessionId, date, text });
    }
    const sourceSHA256 = questionSourcesHash(entry.question, sourceSessions);

    const embeddings: Float32Array[] = [];
    for (const text of seedTexts) {
      embeddings.push(documentCache
        ? await documentCache.embed(text)
        : await generateEmbedding(text, embeddingConfig, "document"));
    }
    for (let si = 0; si < seeded.length; si++) {
      const memoryId = seeded[si]!;
      const text = seedTexts[si]!;
      const embedding = embeddings[si]!;
      storeEmbedding(db, memoryId, text, embedding, embeddingConfig);

      const mem = getMemory(db, memoryId);
      if (mem) {
        upsertMemoryVecRow(
          db,
          { id: mem.id, repo: mem.repo, status: mem.status, type: mem.type, scope: mem.scope },
          {
            embedding: Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
            index_dimensions: info?.index_dimensions ?? embeddingConfig.dimensions,
          },
        );
        upsertMemoryFtsRow(db, {
          id: mem.id,
          text: mem.text,
          note: mem.note ?? null,
          repo: mem.repo,
          status: mem.status,
          type: mem.type,
          scope: mem.scope,
          path_scope: mem.path_scope,
          confidence: mem.confidence,
        });
      }
    }

    const query = normalizeQueryForRetrieval(entry.question);
    const hits = await hybridSearch(db, query, embeddingConfig, {
      repo,
      limit: 20,
    });
    const retrieved = hits.map((hit) => {
      const id = memToSession.get(hit.memory.id);
      const occurrence = memToOccurrence.get(hit.memory.id);
      if (id === undefined || occurrence === undefined) {
        throw new Error(`Missing original-session mapping for retrieved memory ${hit.memory.id}`);
      }
      return { id, occurrence };
    });
    const retrievedSessionIds = retrieved.map((item) => item.id);
    const retrievedSessionOccurrences = retrieved.map((item) => item.occurrence);

    let lexRankIds: string[] | undefined;
    let vecRankIds: string[] | undefined;
    if (args.dumpRaw) {
      const lex = searchMemoryFtsIndex(db, query, { repo, limit: 50 });
      lexRankIds = lex
        .map((r) => memToSession.get(r.memory_id))
        .filter((id): id is string => id != null);
      const queryEmb = projectEmbeddingToIndex(
        await generateEmbedding(query, embeddingConfig, "query"),
        resolveProvider(embeddingConfig).metadata().index_dimensions,
      );
      const vec = searchMemoryVecIndex(db, queryEmb, { repo, limit: 50 });
      vecRankIds = vec
        .map((r) => memToSession.get(r.memory_id))
        .filter((id): id is string => id != null);
    }

    if (qi < 3 && !args.quiet) {
      const memCount = db.select().from(memories).all().filter((m) => m.repo === repo).length;
      const ftsCount = (db.$client as any)
        .prepare("select count(*) as n from fts_memory_index where repo = ?")
        .get(repo) as { n: number };
      const vecCount = (db.$client as any)
        .prepare("select count(*) as n from vec_memory_index where repo = ?")
        .get(repo) as { n: number };
      console.log(
        `  [debug q=${qi}] seeded=${seeded.length} hits=${hits.length} ` +
          `mapped=${retrievedSessionIds.length} ` +
          `gold=${entry.answer_session_ids.length} ` +
          `db_mem=${memCount} fts=${ftsCount?.n ?? "?"} vec=${vecCount?.n ?? "?"} ` +
          `query="${query.slice(0, 60)}"`,
      );
      if (hits.length > 0) {
        console.log(
          `    first 3 hits: ` +
            hits.slice(0, 3).map((h) =>
              `${(memToSession.get(h.memory.id) ?? "??").slice(0, 12)} score=${h.score.toFixed(3)} sim=${h.similarity.toFixed(3)} lex=${h.lexical_score.toFixed(3)}`,
            ).join(" | "),
        );
        console.log(
          `    gold ids: ${entry.answer_session_ids.slice(0, 3).map((g) => g.slice(0, 12)).join(", ")}`,
        );
      }
    }

    const goldSet = new Set(entry.answer_session_ids);
    results.push({
      question_id: entry.question_id,
      question_type: entry.question_type,
      recall_any_at_5: recallAny(retrievedSessionIds, entry.answer_session_ids, 5),
      recall_any_at_10: recallAny(retrievedSessionIds, entry.answer_session_ids, 10),
      recall_any_at_20: recallAny(retrievedSessionIds, entry.answer_session_ids, 20),
      ndcg_at_10: ndcg(retrievedSessionIds, goldSet, 10),
      mrr: mrr(retrievedSessionIds, goldSet),
      retrieved_session_ids: retrievedSessionIds.slice(0, 20),
      retrieved_session_occurrences: retrievedSessionOccurrences.slice(0, 20),
      source_sha256: sourceSHA256,
      gold_session_ids: entry.answer_session_ids,
      lex_rank_session_ids: lexRankIds,
      vec_rank_session_ids: vecRankIds,
    });

    for (const id of seeded) {
      db.delete(memories).where(eq(memories.id, id)).run();
      memToSession.delete(id);
      memToOccurrence.delete(id);
    }

    reporter.record(
      results.at(-1)!,
      results.length,
      seeded.length,
      documentCache?.stats() ?? { hits: 0, misses: 0, entries: 0 },
    );
    lastSourceCount = seeded.length;

    if (!args.quiet && (qi + 1) % 10 === 0) {
      const elapsed = (Date.now() - startedAt) / 1000;
      const r5 = results.reduce((s, r) => s + r.recall_any_at_5, 0) / results.length;
      const rate = (qi + 1) / elapsed;
      const remaining = (entries.length - qi - 1) / rate;
      process.stdout.write(
        `  [${qi + 1}/${entries.length}] R@5=${(r5 * 100).toFixed(1)}% · ` +
          `${rate.toFixed(2)}/s · eta ${Math.round(remaining)}s\n`,
      );
    }
  }

  const cache: CacheStats = documentCache?.stats() ?? { hits: 0, misses: 0, entries: 0 };
  const report = summarizeRetrieval(
    results,
    providerMetadata,
    args.cacheEmbeddings,
    cache,
    Math.round((Date.now() - startedAt) / 1000),
  );
  const { summary, by_type: byType } = report;

  console.log("\n=== Recall LongMemEval-S ===");
  console.log(JSON.stringify(summary, null, 2));

  console.log("\nBy question type:");
  for (const [t, rs] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
    const r5 = (rs.reduce((s, r) => s + r.recall_any_at_5, 0) / rs.length) * 100;
    const r10 = (rs.reduce((s, r) => s + r.recall_any_at_10, 0) / rs.length) * 100;
    console.log(
      `  ${t.padEnd(32)} n=${rs.length.toString().padStart(3)} ` +
        `R@5=${r5.toFixed(1).padStart(5)}% R@10=${r10.toFixed(1).padStart(5)}%`,
    );
  }

  const completed = {
    status: "complete",
    selected_question_ids: entries.map((entry) => entry.question_id),
    dataset_sha256: datasetSHA256,
    harness_sha256: harnessSHA256,
    runtime: {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    local_provider: providerMetadata,
    resolved_embedding_config: resolvedEmbeddingConfig,
    provenance,
    cache_embeddings: { enabled: args.cacheEmbeddings, stats: cache },
    summary,
    by_type: byType,
    results,
  };
  reporter.complete(completed, lastSourceCount, cache);
  if (args.out) console.log(`\nresults → ${args.out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
