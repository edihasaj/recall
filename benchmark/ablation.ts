/**
 * Ablation harness for the LongMemEval-S bench. For each question we seed
 * the haystack once and then run hybridSearch under multiple named configs,
 * flipping env vars between calls. Outputs one summary row per config so
 * the cost of each retrieval feature is visible side-by-side.
 *
 * Usage:
 *   npx tsx benchmark/ablation.ts \
 *     [--limit N] [--stratify] [--quiet] \
 *     [--configs baseline,nosyn,noprefix,weighted,hyde,rerank,all] \
 *     [--out FILE]
 *
 * Configs are evaluated in the order given; each rebuilds query-time
 * settings only (the FTS5 index keeps Porter+unicode61 throughout). For
 * `nostem` you'd need a different index — out of scope here.
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

interface ConfigSpec {
  label: string;
  env: Record<string, string | undefined>;
}

const PRESETS: Record<string, ConfigSpec> = {
  baseline: {
    label: "baseline",
    env: {
      RECALL_FUSION: undefined,
      RECALL_SYNONYMS: undefined,
      RECALL_FTS_PREFIX: undefined,
      RECALL_HYDE: undefined,
      RECALL_RERANK: undefined,
    },
  },
  nosyn: {
    label: "no-synonyms",
    env: { RECALL_SYNONYMS: "false" },
  },
  noprefix: {
    label: "no-prefix",
    env: { RECALL_FTS_PREFIX: "false" },
  },
  weighted: {
    label: "weighted-fusion",
    env: { RECALL_FUSION: "weighted" },
  },
  ormode: {
    label: "fts-or-mode",
    env: { RECALL_FTS_MODE: "or" },
  },
  hyde: {
    label: "hyde-on",
    env: { RECALL_HYDE: "true" },
  },
  rerank: {
    label: "rerank-on",
    env: { RECALL_RERANK: "true" },
  },
  all: {
    label: "all-features",
    env: { RECALL_HYDE: "true", RECALL_RERANK: "true" },
  },
};

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

interface Args {
  limit?: number;
  stratify: boolean;
  quiet: boolean;
  configs: string[];
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    stratify: false,
    quiet: false,
    configs: ["baseline", "nosyn", "noprefix", "weighted", "hyde", "rerank", "all"],
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") out.limit = parseInt(argv[++i] ?? "0", 10);
    else if (a === "--stratify") out.stratify = true;
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--configs") out.configs = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--out") out.out = argv[++i];
  }
  return out;
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
  // Seeded shuffle inside each type bucket so the same RECALL_STRATIFY_SEED
  // reproduces the slice and different seeds rotate it. Without this the
  // round-robin below locks to the dataset's natural ordering.
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

function applyEnv(spec: ConfigSpec, saved: Map<string, string | undefined>): void {
  for (const [key, value] of Object.entries(spec.env)) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreEnv(saved: Map<string, string | undefined>): void {
  for (const [key, value] of saved.entries()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
}

interface ConfigStats {
  label: string;
  questions: number;
  r5: number;
  r10: number;
  r20: number;
  byType: Map<string, { n: number; r5: number; r10: number }>;
}

async function main() {
  const args = parseArgs(process.argv);
  for (const cfg of args.configs) {
    if (!PRESETS[cfg]) {
      console.error(`unknown preset: ${cfg}. valid: ${Object.keys(PRESETS).join(", ")}`);
      process.exit(1);
    }
  }

  // Mirror longmemeval.ts — production defaults zero out chat-haystack
  // retrieval; ensure the chat-mode floor is off before any preset runs.
  for (const [key, value] of Object.entries({
    RECALL_HYBRID_MIN_SIM: "0",
    RECALL_SIMILARITY_THRESHOLD: "0",
    RECALL_FTS_MODE: "or",
  })) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  const datasetPath = fileURLToPath(new URL("./data/longmemeval_s_cleaned.json", import.meta.url));
  if (!existsSync(datasetPath)) {
    console.error(`Dataset not found: ${datasetPath}`);
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(datasetPath, "utf-8")) as LongMemEvalEntry[];
  let entries = raw.filter((e) => !ABSTENTION_TYPES.has(e.question_type));
  if (args.limit && args.limit < entries.length) {
    entries = args.stratify ? stratifySample(entries, args.limit) : entries.slice(0, args.limit);
  }
  console.log(
    `ablation · ${entries.length} questions · configs: ${args.configs.join(", ")}`,
  );

  const embeddingConfig = loadEmbeddingConfigFromEnv();
  if (!embeddingConfig) {
    console.error("no embedding provider configured");
    process.exit(1);
  }
  const info = await ensureEmbeddingProviderReady(embeddingConfig);

  const tmp = mkdtempSync(join(tmpdir(), "recall-lme-ablate-"));
  const dbPath = join(tmp, "lme.db");
  const db = initStandaloneDb(dbPath);

  const stats = new Map<string, ConfigStats>();
  for (const name of args.configs) {
    stats.set(name, {
      label: PRESETS[name]!.label,
      questions: 0,
      r5: 0,
      r10: 0,
      r20: 0,
      byType: new Map(),
    });
  }

  const memToSession = new Map<string, string>();
  const startedAt = Date.now();
  const savedEnv = new Map<string, string | undefined>();

  for (let qi = 0; qi < entries.length; qi++) {
    const entry = entries[qi]!;
    const repo = `q_${qi}_${entry.question_id.slice(0, 8)}`;
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

    const embeddings: Float32Array[] = [];
    for (const text of seedTexts) {
      embeddings.push(await generateEmbedding(text, embeddingConfig, "document"));
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

    for (const cfgName of args.configs) {
      const preset = PRESETS[cfgName]!;
      applyEnv(preset, savedEnv);
      const hits = await hybridSearch(db, query, embeddingConfig, { repo, limit: 20 });
      const ids = hits
        .map((h) => memToSession.get(h.memory.id))
        .filter((id): id is string => id != null);
      const slot = stats.get(cfgName)!;
      slot.questions += 1;
      const a5 = recallAny(ids, entry.answer_session_ids, 5);
      const a10 = recallAny(ids, entry.answer_session_ids, 10);
      const a20 = recallAny(ids, entry.answer_session_ids, 20);
      slot.r5 += a5;
      slot.r10 += a10;
      slot.r20 += a20;
      const t = slot.byType.get(entry.question_type) ?? { n: 0, r5: 0, r10: 0 };
      t.n += 1;
      t.r5 += a5;
      t.r10 += a10;
      slot.byType.set(entry.question_type, t);
      restoreEnv(savedEnv);
    }

    for (const id of seeded) {
      db.delete(memories).where(eq(memories.id, id)).run();
      memToSession.delete(id);
    }

    if (!args.quiet && (qi + 1) % 5 === 0) {
      const elapsed = (Date.now() - startedAt) / 1000;
      const rate = (qi + 1) / elapsed;
      const remaining = (entries.length - qi - 1) / rate;
      process.stdout.write(
        `  [${qi + 1}/${entries.length}] ${rate.toFixed(2)}/s · eta ${Math.round(remaining)}s\n`,
      );
    }
  }

  console.log("\n=== Ablation summary ===");
  console.log(
    `${"Config".padEnd(20)} ${"n".padStart(4)} ${"R@5".padStart(7)} ${"R@10".padStart(7)} ${"R@20".padStart(7)}`,
  );
  const rows = [...stats.entries()].map(([name, s]) => ({
    name,
    label: s.label,
    n: s.questions,
    r5: (s.r5 / s.questions) * 100,
    r10: (s.r10 / s.questions) * 100,
    r20: (s.r20 / s.questions) * 100,
    byType: s.byType,
  }));
  rows.sort((a, b) => b.r5 - a.r5);
  for (const row of rows) {
    console.log(
      `${row.label.padEnd(20)} ${row.n.toString().padStart(4)} ${row.r5.toFixed(2).padStart(7)} ${row.r10.toFixed(2).padStart(7)} ${row.r20.toFixed(2).padStart(7)}`,
    );
  }

  if (args.out) {
    const dump = rows.map((r) => ({
      config: r.name,
      label: r.label,
      n: r.n,
      r5: r.r5,
      r10: r.r10,
      r20: r.r20,
      by_type: Object.fromEntries(
        [...r.byType.entries()].map(([t, v]) => [
          t,
          { n: v.n, r5: (v.r5 / v.n) * 100, r10: (v.r10 / v.n) * 100 },
        ]),
      ),
    }));
    writeFileSync(args.out, JSON.stringify(dump, null, 2));
    console.log(`\nresults → ${args.out}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
