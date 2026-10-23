/** Diagnostic only: re-score saved answers several times with the unchanged judge. It never changes a recorded result. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { longRequestFetch } from "./longmemeval-qa-transport.js";
import { createModelCall, judgePrompt, parseJudge, sha256, type Case } from "./longmemeval-qa-support.js";

const ORIGINAL7 = ["0a995998", "6d550036", "3a704032", "dd2973ad", "32260d93", "b46e15ed", "830ce83f"];
type Saved = { question_id: string; answer: string | null; correct: boolean | null };

/** P(sum of independent Bernoulli(p_i) >= k). */
function atLeast(ps: number[], k: number): number {
  let dist = [1];
  for (const p of ps) {
    const next = new Array(dist.length + 1).fill(0);
    dist.forEach((v, i) => { next[i] += v * (1 - p); next[i + 1] += v * p; });
    dist = next;
  }
  return dist.slice(Math.max(0, k)).reduce((a, b) => a + b, 0);
}

async function main([out, inputPath, repeatsArg, ...reports]: string[]) {
  if (!out || !inputPath || !repeatsArg || !reports.length) throw new Error("usage: judge-consistency <out.json> <input.json> <repeats> <report.json>...");
  if (existsSync(out)) throw new Error("Output already exists");
  const repeats = Number(repeatsArg);
  if (!Number.isInteger(repeats) || repeats < 2 || repeats > 10) throw new Error("repeats must be 2-10");
  const cases = new Map((JSON.parse(readFileSync(inputPath, "utf8")) as { cases: Case[] }).cases.map((c) => [c.question_id, c]));
  const call = createModelCall("qwen-local", longRequestFetch, { structuredOutput: true });
  const loaded = reports.map((path) => ({ path, sha256: sha256(readFileSync(path)), rows: (JSON.parse(readFileSync(path, "utf8")) as { results: Saved[] }).results }));
  const verdicts = loaded.map((report) => report.rows.map(() => [] as (boolean | null)[]));
  const tasks = loaded.flatMap((report, r) => report.rows.flatMap((row, i) => row.answer === null ? [] : Array.from({ length: repeats }, () => [r, i] as const)));
  let next = 0;
  const worker = async () => {
    for (;;) {
      const t = next++; if (t >= tasks.length) return;
      const [r, i] = tasks[t]!; const row = loaded[r]!.rows[i]!;
      const judged = await call("judge", judgePrompt(cases.get(row.question_id)!, row.answer!));
      verdicts[r]![i]!.push(judged.error ? null : parseJudge(judged.text));
      if (t % 100 === 0) console.log(JSON.stringify({ done: t, of: tasks.length }));
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const summaries = loaded.map((report, r) => {
    const rows = report.rows.map((row, i) => {
      const v = verdicts[r]![i]!; const valid = v.filter((x) => x !== null) as boolean[];
      const rate = row.answer === null ? 0 : valid.length ? valid.filter(Boolean).length / valid.length : 0;
      return { question_id: row.question_id, recorded: row.correct, verdicts: v, rate };
    });
    const o7 = rows.filter((row) => ORIGINAL7.includes(row.question_id));
    const others = rows.filter((row) => !ORIGINAL7.includes(row.question_id));
    const pAllO7 = o7.reduce((a, row) => a * row.rate, 1);
    return {
      report: report.path, report_sha256: report.sha256, recorded_correct: report.rows.filter((row) => row.correct === true).length,
      expected_correct: rows.reduce((a, row) => a + row.rate, 0),
      unstable: rows.filter((row) => row.rate > 0 && row.rate < 1).map((row) => ({ question_id: row.question_id, rate: row.rate, recorded: row.recorded })),
      always_wrong: rows.filter((row) => row.rate === 0).map((row) => row.question_id),
      p_gate1_given_answers: pAllO7 * atLeast(others.map((row) => row.rate), 58 - o7.length),
      rows,
    };
  });
  writeFileSync(out, `${JSON.stringify({ diagnostic: "Re-scoring saved answers with the unchanged none/4,096 judge. No recorded result, gate or decision is changed.", repeats, runtime: process.version, summaries })}\n`, { flag: "wx" });
  console.log(JSON.stringify(summaries.map(({ rows: _rows, ...s }) => s)));
}
main(process.argv.slice(2)).catch((error) => { console.error(String(error)); process.exitCode = 1; });
