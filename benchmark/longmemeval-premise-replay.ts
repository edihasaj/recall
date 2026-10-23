/** Development-only replay: rerun the separate premise check on saved answers and evidence, judging only rows whose final answer can change. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { answerGenerationClock } from "./longmemeval-answer-review.js";
import { premiseAbstention, premiseCheckPrompt } from "./longmemeval-premise-check.js";
import { longRequestFetch } from "./longmemeval-qa-transport.js";
import { createModelCall, judgePrompt, parseJudge, parseObject, sha256, type Case } from "./longmemeval-qa-support.js";

type Saved = { question_id: string; is_abstention: boolean; correct: boolean | null; error: string | null; draft_answer?: string | null; premise_override?: boolean; evidence: { text: string } | null };

async function main([reportPath, inputPath, out]: string[]) {
  if (!reportPath || !inputPath || !out) throw new Error("usage: replay <report.json> <input.json> <out.json>");
  if (existsSync(out)) throw new Error("Output already exists");
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as { results: Saved[] };
  const cases = new Map((JSON.parse(readFileSync(inputPath, "utf8")) as { cases: Case[] }).cases.map((c) => [c.question_id, c]));
  const call = createModelCall("qwen-local", longRequestFetch, { structuredOutput: true });
  const rows: Record<string, unknown>[] = new Array(report.results.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++; if (i >= report.results.length) return;
      const old = report.results[i]!, item = cases.get(old.question_id)!;
      const base = { question_id: old.question_id, is_abstention: old.is_abstention, old_correct: old.correct, old_override: Boolean(old.premise_override) };
      if (!old.draft_answer || !old.evidence) { rows[i] = { ...base, skipped: old.error ?? "no_draft", correct: old.correct, override: Boolean(old.premise_override) }; continue; }
      const check = await call("premise", premiseCheckPrompt(item.question, answerGenerationClock(item.answer_prompt_prefix), old.evidence.text));
      const parsed = check.error ? null : parseObject(check.text);
      const recorded = typeof parsed?.correct === "boolean" ? parsed.correct : null;
      const override = recorded === false;
      const answer = override ? premiseAbstention(typeof parsed?.reason === "string" ? parsed.reason : "") : old.draft_answer;
      let correct = old.correct, judge = null;
      if (override || old.premise_override) {
        judge = await call("judge", judgePrompt(item, answer));
        correct = judge.error ? false : parseJudge(judge.text) ?? false;
      }
      rows[i] = { ...base, recorded, override, answer, correct, check_call: check, judge_call: judge };
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const n = (f: (r: Record<string, unknown>) => boolean) => rows.filter(f).length;
  const summary = {
    rows: rows.length, correct: n((r) => r.correct === true), old_correct: n((r) => r.old_correct === true),
    abstention: `${n((r) => r.is_abstention === true && r.correct === true)}/${n((r) => r.is_abstention === true)}`,
    overrides: n((r) => r.override === true), wrong_overrides: n((r) => r.override === true && r.is_abstention === false),
    check_failures: n((r) => r.recorded === null && !r.skipped),
  };
  writeFileSync(out, `${JSON.stringify({ report_sha256: sha256(readFileSync(reportPath)), check_source_sha256: sha256(readFileSync(new URL("./longmemeval-premise-check.ts", import.meta.url))), runtime: process.version, summary, rows })}\n`, { flag: "wx" });
  console.log(JSON.stringify(summary));
}
main(process.argv.slice(2)).catch((error) => { console.error(String(error)); process.exitCode = 1; });
