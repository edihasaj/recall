/**
 * Offline fusion-mix sweep against a LongMemEval-S results JSON that has
 * been produced with `benchmark/longmemeval.ts --dump-raw`.
 *
 * Each result must carry `lex_rank_session_ids` and `vec_rank_session_ids`
 * (the per-arm top-K rankings). We re-fuse the two arms under multiple
 * configurations and report R@5/R@10/R@20 + per-type breakdowns so we can
 * pick a default before paying for a re-bench.
 *
 * Usage:
 *   npx tsx benchmark/fusion-sweep.ts <results.json>
 */
import { readFileSync } from "node:fs";

interface BenchResult {
  question_id: string;
  question_type: string;
  gold_session_ids: string[];
  lex_rank_session_ids?: string[];
  vec_rank_session_ids?: string[];
}

interface Dataset {
  results: BenchResult[];
}

interface FusionConfig {
  label: string;
  fuse: (
    lex: string[],
    vec: string[],
  ) => string[];
}

function rrf(
  lex: string[],
  vec: string[],
  k: number,
  lexW: number,
  vecW: number,
): string[] {
  const scores = new Map<string, number>();
  for (let i = 0; i < lex.length; i++) {
    scores.set(lex[i]!, (scores.get(lex[i]!) ?? 0) + lexW / (k + i + 1));
  }
  for (let i = 0; i < vec.length; i++) {
    scores.set(vec[i]!, (scores.get(vec[i]!) ?? 0) + vecW / (k + i + 1));
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}

function weightedSum(
  lex: string[],
  vec: string[],
  lexW: number,
  vecW: number,
): string[] {
  // Mirror src/embeddings/embeddings.ts lexicalRankToScore + (1 - distance)
  // proxy. We don't have distances offline, so use rank-derived scores.
  const score = (rank: number) => 1 / (1 + rank + 1);
  const m = new Map<string, number>();
  for (let i = 0; i < lex.length; i++) {
    m.set(lex[i]!, (m.get(lex[i]!) ?? 0) + lexW * score(i));
  }
  for (let i = 0; i < vec.length; i++) {
    m.set(vec[i]!, (m.get(vec[i]!) ?? 0) + vecW * score(i));
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}

function recallAt(retrieved: string[], gold: string[], k: number): number {
  const top = new Set(retrieved.slice(0, k));
  return gold.some((id) => top.has(id)) ? 1 : 0;
}

function evalConfig(cfg: FusionConfig, results: BenchResult[]) {
  let r5 = 0, r10 = 0, r20 = 0;
  const byType = new Map<string, { n: number; r5: number; r10: number }>();
  for (const r of results) {
    const lex = r.lex_rank_session_ids ?? [];
    const vec = r.vec_rank_session_ids ?? [];
    const fused = cfg.fuse(lex, vec);
    const a5 = recallAt(fused, r.gold_session_ids, 5);
    const a10 = recallAt(fused, r.gold_session_ids, 10);
    const a20 = recallAt(fused, r.gold_session_ids, 20);
    r5 += a5;
    r10 += a10;
    r20 += a20;
    const slot = byType.get(r.question_type) ?? { n: 0, r5: 0, r10: 0 };
    slot.n += 1;
    slot.r5 += a5;
    slot.r10 += a10;
    byType.set(r.question_type, slot);
  }
  const n = results.length;
  return {
    label: cfg.label,
    r5: (r5 / n) * 100,
    r10: (r10 / n) * 100,
    r20: (r20 / n) * 100,
    byType,
  };
}

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: tsx benchmark/fusion-sweep.ts <results.json>");
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(path, "utf-8")) as Dataset;
  const results = data.results ?? [];
  const have = results.filter(
    (r) => r.lex_rank_session_ids && r.vec_rank_session_ids,
  );
  if (have.length === 0) {
    console.error(
      "no per-arm rankings in this JSON. Re-run benchmark/longmemeval.ts with --dump-raw.",
    );
    process.exit(1);
  }
  console.log(
    `loaded ${results.length} questions; ${have.length} with per-arm dumps`,
  );

  const configs: FusionConfig[] = [];
  // RRF k sweep, balanced weights
  for (const k of [10, 20, 30, 40, 60, 80, 120]) {
    configs.push({
      label: `RRF k=${k} (1:1)`,
      fuse: (l, v) => rrf(l, v, k, 1, 1),
    });
  }
  // RRF arm-weight sweep at k=60
  for (const [lexW, vecW] of [
    [0.5, 1.5],
    [0.75, 1.25],
    [1, 1],
    [1.25, 0.75],
    [1.5, 0.5],
    [2, 1],
    [1, 2],
  ] as Array<[number, number]>) {
    configs.push({
      label: `RRF k=60 (lex=${lexW}, vec=${vecW})`,
      fuse: (l, v) => rrf(l, v, 60, lexW, vecW),
    });
  }
  // Weighted-sum baselines (mirror current production at 0.35/0.65 and 0.40/0.60)
  for (const [lexW, vecW] of [
    [0.35, 0.65],
    [0.4, 0.6],
    [0.5, 0.5],
    [0.6, 0.4],
  ] as Array<[number, number]>) {
    configs.push({
      label: `Weighted lex=${lexW} vec=${vecW}`,
      fuse: (l, v) => weightedSum(l, v, lexW, vecW),
    });
  }
  // Single-arm baselines
  configs.push({ label: "LEX-only", fuse: (l) => l });
  configs.push({ label: "VEC-only", fuse: (_l, v) => v });

  const rows = configs.map((c) => evalConfig(c, have));
  rows.sort((a, b) => b.r5 - a.r5);

  console.log("\n=== Fusion sweep · ranked by R@5 ===");
  console.log(
    `${"Config".padEnd(30)} ${"R@5".padStart(7)} ${"R@10".padStart(7)} ${"R@20".padStart(7)}`,
  );
  for (const row of rows) {
    console.log(
      `${row.label.padEnd(30)} ${row.r5.toFixed(2).padStart(7)} ${row.r10.toFixed(2).padStart(7)} ${row.r20.toFixed(2).padStart(7)}`,
    );
  }

  // Show per-type breakdown for the top config
  const best = rows[0]!;
  console.log(`\n=== Best (${best.label}) per-type R@5 ===`);
  for (const [t, slot] of [...best.byType.entries()].sort()) {
    console.log(
      `  ${t.padEnd(32)} n=${slot.n.toString().padStart(3)} R@5=${((slot.r5 / slot.n) * 100).toFixed(1).padStart(5)}% R@10=${((slot.r10 / slot.n) * 100).toFixed(1).padStart(5)}%`,
    );
  }
}

main();
