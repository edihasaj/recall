/**
 * Recall side of the LongMemEval-S retrieval benchmark.
 *
 * Mirrors the methodology in
 *   ~/Projects/oss/agentmemory/benchmark/longmemeval-bench.ts
 * and
 *   ~/Projects/oss/agentmemory/benchmark/LONGMEMEVAL.md
 *
 * For each question:
 *   1. Build a fresh haystack of ~48 sessions as memories in a temp DB,
 *      tagged with repo=`q_<idx>` so they don't bleed into other questions.
 *   2. Embed + store each session via Recall's normal pipeline.
 *   3. Call hybridSearch(db, question, config, { repo, limit: 20 }).
 *   4. Score recall_any@{5,10,20}, NDCG@10, MRR.
 *
 * Usage:
 *   npx tsx benchmark/longmemeval.ts [--limit N] [--out FILE] [--quiet]
 *
 * Defaults to the full 500-question set excluding abstention variants.
 * The dataset must live at benchmark/data/longmemeval_s_cleaned.json
 * (264 MB, fetched from xiaowu0162/longmemeval-cleaned on HF).
 */
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { initStandaloneDb } from "../src/db/client.js";
import {
  generateEmbedding,
  hybridSearch,
  loadEmbeddingConfigFromEnv,
  storeEmbedding,
  ensureEmbeddingProviderReady,
} from "../src/embeddings/embeddings.js";
import { upsertMemoryVecRow } from "../src/vector/sqlite-vec.js";
import { upsertMemoryFtsRow } from "../src/vector/sqlite-fts.js";
import { getMemory } from "../src/models/memory.js";
import { normalizeQueryForRetrieval } from "../src/compiler/context.js";
import { memories } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

interface LongMemEvalEntry {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  answer_session_ids: string[];
  haystack_session_ids: string[];
  haystack_sessions: Array<Array<{ role: string; content: string; has_answer?: boolean }>>;
}

interface BenchResult {
  question_id: string;
  question_type: string;
  recall_any_at_5: number;
  recall_any_at_10: number;
  recall_any_at_20: number;
  ndcg_at_10: number;
  mrr: number;
  retrieved_session_ids: string[];
  gold_session_ids: string[];
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

function parseArgs(argv: string[]): { limit?: number; out?: string; quiet: boolean } {
  const out: { limit?: number; out?: string; quiet: boolean } = { quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") out.limit = parseInt(argv[++i] ?? "0", 10);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--quiet") out.quiet = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  const datasetPath = fileURLToPath(
    new URL("./data/longmemeval_s_cleaned.json", import.meta.url),
  );
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
  const raw = JSON.parse(readFileSync(datasetPath, "utf-8")) as LongMemEvalEntry[];
  process.stdout.write(` ${raw.length} entries in ${Date.now() - t0}ms\n`);

  let entries = raw.filter((e) => !ABSTENTION_TYPES.has(e.question_type));
  if (args.limit && args.limit < entries.length) {
    entries = entries.slice(0, args.limit);
  }
  console.log(
    `processing ${entries.length} non-abstention questions ` +
      `(${raw.length - entries.length} excluded as abstention)`,
  );

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

  // One DB per run, repo-scoped haystacks. Cheaper than initStandaloneDb per
  // question (sqlite-vec setup + drizzle migrations cost ~80ms each).
  const tmp = mkdtempSync(join(tmpdir(), "recall-lme-"));
  const dbPath = join(tmp, "lme.db");
  const db = initStandaloneDb(dbPath);
  console.log(`temp db: ${dbPath}`);

  const results: BenchResult[] = [];
  const memToSession = new Map<string, string>();
  const startedAt = Date.now();

  for (let qi = 0; qi < entries.length; qi++) {
    const entry = entries[qi]!;
    const repo = `q_${qi}_${entry.question_id.slice(0, 8)}`;

    // 1) Seed haystack memories for this question. We bypass createMemory()
    //    intentionally: it queues an async embedding sync per row via
    //    queueMemoryEmbeddingSync, and 50 of those firing in parallel against
    //    a single-threaded inference worker plus the same sqlite handle is
    //    the path to a 0%-CPU deadlock. Insert raw, then drive the batched
    //    embed + index upserts ourselves below.
    const seeded: string[] = [];
    const seedTexts: string[] = [];
    const now = new Date().toISOString();
    for (let si = 0; si < entry.haystack_sessions.length; si++) {
      const sessionId = entry.haystack_session_ids[si]!;
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
    }

    // Single-call embed per session. Batched (`embedBatch`) leaks worker
    // threads across calls under transformers.js's onnxruntime, growing RSS
    // unboundedly across questions; one-at-a-time keeps memory flat at the
    // cost of throughput. The per-call cost is dominated by the model itself,
    // not by tokenizer overhead, so the speed delta vs batched is small.
    const embeddings: Float32Array[] = [];
    for (const text of seedTexts) {
      embeddings.push(await generateEmbedding(text, embeddingConfig, "document"));
    }
    for (let si = 0; si < seeded.length; si++) {
      const memoryId = seeded[si]!;
      const text = seedTexts[si]!;
      const embedding = embeddings[si]!;
      storeEmbedding(db, memoryId, text, embedding, embeddingConfig);

      // Mirror the embedding into the sqlite-vec ANN index AND the FTS5
      // lexical index. The normal sync path is queue-driven and asynchronous;
      // we want both rows visible to hybridSearch immediately for the benchmark
      // cycle.
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
          repo: mem.repo,
          status: mem.status,
          type: mem.type,
          scope: mem.scope,
          path_scope: mem.path_scope,
          confidence: mem.confidence,
        });
      }
    }

    // 2) Search. normalizeQueryForRetrieval strips harness wrappers — the
    // dataset is clean conversational text so this is a near no-op here.
    const query = normalizeQueryForRetrieval(entry.question);
    const hits = await hybridSearch(db, query, embeddingConfig, {
      repo,
      limit: 20,
    });
    const retrievedSessionIds = hits
      .map((h) => memToSession.get(h.memory.id))
      .filter((id): id is string => id != null);

    if (qi < 3 && !args.quiet) {
      // Sanity counts directly from the DB.
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
      retrieved_session_ids: retrievedSessionIds.slice(0, 10),
      gold_session_ids: entry.answer_session_ids,
    });

    // 3) Drop the per-question rows so the next question starts clean.
    // sqlite-vec rows clean up via the deleteMemory hook; vec_memories also
    // gets pruned by memory_id FK cascade.
    for (const id of seeded) {
      db.delete(memories).where(eq(memories.id, id)).run();
      memToSession.delete(id);
    }

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

  // Summary stats.
  const mean = (k: keyof BenchResult) =>
    (results.reduce((s, r) => s + (r[k] as number), 0) / results.length) * 100;
  const summary = {
    questions: results.length,
    embedding_provider: embeddingConfig.provider,
    embedding_model: embeddingConfig.model,
    recall_any_at_5: mean("recall_any_at_5"),
    recall_any_at_10: mean("recall_any_at_10"),
    recall_any_at_20: mean("recall_any_at_20"),
    ndcg_at_10: mean("ndcg_at_10"),
    mrr: mean("mrr"),
    total_seconds: Math.round((Date.now() - startedAt) / 1000),
  };

  console.log("\n=== Recall LongMemEval-S ===");
  console.log(JSON.stringify(summary, null, 2));

  // Per-type breakdown.
  const byType = new Map<string, BenchResult[]>();
  for (const r of results) {
    const list = byType.get(r.question_type) ?? [];
    list.push(r);
    byType.set(r.question_type, list);
  }
  console.log("\nBy question type:");
  for (const [t, rs] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const r5 = (rs.reduce((s, r) => s + r.recall_any_at_5, 0) / rs.length) * 100;
    const r10 = (rs.reduce((s, r) => s + r.recall_any_at_10, 0) / rs.length) * 100;
    console.log(
      `  ${t.padEnd(32)} n=${rs.length.toString().padStart(3)} ` +
        `R@5=${r5.toFixed(1).padStart(5)}% R@10=${r10.toFixed(1).padStart(5)}%`,
    );
  }

  if (args.out) {
    writeFileSync(
      args.out,
      JSON.stringify({ summary, by_type: Object.fromEntries(byType), results }, null, 2),
    );
    console.log(`\nresults → ${args.out}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
