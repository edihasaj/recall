/**
 * Bounded saved-answer replay for the historical premise-override cohort. It reviews the original pre-premise
 * draft against refreshed evidence and re-judges it; every other historical answer is reused. This is a mixed
 * saved-answer replay, never a fresh full500 run. Models see neither question IDs, labels, references nor gold data.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSupplementalEvidence } from "./longmemeval-supplemental-evidence.js";
import { answerGenerationClock, answerTaskContract, groundedAnswerReviewPrompt } from "./longmemeval-answer-review.js";
import { longRequestFetch } from "./longmemeval-qa-transport.js";
import { questionSourcesHash } from "./longmemeval-source-identity.js";
import { HISTORY_EVIDENCE_POLICY } from "../src/history/evidence-policy.js";
import { MINIMAL_ANSWER_POLICY } from "./longmemeval-minimal-answer-policy.js";
import {
  cachedRank, createModelCall, judgePrompt, lexicalRank, parseAnswer, parseJudge, safeError, selectCases, sha256,
  type Call, type Case, type ModelCall, type Ranked, type Ranking,
} from "./longmemeval-qa-support.js";

export const BASELINE_SHA256 = "9cba4555cad8031eec9e404d96ae4f7065c302cbacfa8a87f1232c0b9e0105f0";
export const REPLAY = {
  retained: 18, reserve: 2, lexicalLimit: 40, contextChars: 180_000, reviewTokens: 8192, judgeTokens: 4096,
  timeoutMs: 600_000, targetCorrect: 476, maxConcurrency: 3, questions: 500, overrides: 29,
} as const;
export const ANSWER_INSTRUCTIONS = [HISTORY_EVIDENCE_POLICY, MINIMAL_ANSWER_POLICY].join("\n\n");
const BASELINE_INVOCATION: Record<string, unknown> = {
  retrieval: "cached", topK: 20, contextChars: 180000, evidence: "supplemental", evidencePolicy: "system",
  answerPolicy: "minimal", answerCheck: "premise", answerRecovery: "longer-timeout-transport", provider: "qwen-local",
  requestMode: "robust", reasoningEffort: "adaptive",
};
const CODE_FILES = [
  "./longmemeval-qa-support.ts", "./longmemeval-qa-transport.ts", "./longmemeval-supplemental-evidence.ts",
  "./longmemeval-highlighted-evidence.ts", "./longmemeval-focused-evidence.ts", "./longmemeval-answer-review.ts",
  "./longmemeval-source-identity.ts", "./longmemeval-inference-policy.ts", "./longmemeval-minimal-answer-policy.ts",
  "../src/history/evidence.ts", "../src/history/evidence-policy.ts", "../src/text/match.ts", "../src/vector/sqlite-fts.ts",
  "../src/vector/synonyms.ts", "../src/data/synonyms.en.json", "../src/models/retrieval-text.ts", "./temporal-model.ts",
];

export type BaselineRow = {
  question_id: string; is_abstention: boolean; correct: boolean; error: string | null; premise_override: boolean;
  draft_answer?: string | null; answer: string | null; evidence?: { text?: string } | null;
};
export type BaselineReport = {
  status: string; comparison_valid: boolean; hashes: { input?: string; rankings?: string };
  invocation: Record<string, unknown>; generation_blinding: string;
  summary: { planned: number; recorded?: number; errors: number }; results: BaselineRow[];
};
type Coverage = { any: boolean | null; all: boolean | null };
export type ReplayRow = {
  question_id: string; question_type: string; is_abstention: boolean; // scorer-side only, never sent to a model
  baseline_correct: boolean; baseline_answer: string | null; draft_answer: string | null;
  evidence: { text: string; chars: number; sources: unknown[]; supplemental?: unknown } | null;
  source_changes: {
    retained_occurrences: number[]; lexical_tail_selections: number[]; added_occurrences: number[]; dropped_occurrences: number[];
  } | null;
  gold_coverage: { baseline: Coverage; refreshed: Coverage } | null;
  review_prompt_sha256: string | null; review_call: Call | null; review_answer: string | null;
  judge_call: Call | null; replay_correct: boolean | null; error: string | null;
};
/** One logical model call is journaled twice: a start event before the await and a finish event after it. */
export type JournalStart = { seq: number; event: "start"; at: string; question_id: string; kind: string; prompt_sha256: string };
export type JournalFinish = {
  seq: number; event: "finish"; start_seq: number; at: string; question_id: string; kind: string; prompt_sha256: string; model: string;
  error: string | null; attempts: number; elapsed_ms: number; usage_known: boolean; usage: Record<string, unknown> | null;
  request_config: Call["request_config"] | null;
};
export type JournalEntry = JournalStart | JournalFinish;
type Unsequenced = JournalEntry extends infer T ? T extends unknown ? Omit<T, "seq"> : never : never;
export type ReplayOptions = {
  baseline: string; input: string; rankings: string; out: string; live: boolean; concurrency: number;
  baselineSha256?: string; expectedQuestions?: number; target?: number;
};

/** Fail closed unless the historical report is complete, error-free and bound to the supplied input and rankings. */
export function validateBaseline(
  report: BaselineReport, sha: { baseline: string; input: string; rankings: string }, caseIds: string[],
  expected: { sha256?: string; questions: number },
): void {
  if (expected.sha256 !== undefined && sha.baseline !== expected.sha256) throw new Error("Baseline fingerprint mismatch");
  if (report.status !== "complete" || report.comparison_valid !== true) throw new Error("Baseline is not a complete valid report");
  const rows = report.results;
  if (!Array.isArray(rows) || rows.length !== expected.questions || report.summary?.planned !== expected.questions
    || report.summary.recorded !== expected.questions || report.summary.errors !== 0) throw new Error("Baseline is not complete");
  if (report.hashes?.input !== sha.input || report.hashes?.rankings !== sha.rankings) throw new Error("Input or rankings do not match baseline hashes");
  const ids = new Set(rows.map((row) => row.question_id));
  if (ids.size !== rows.length || caseIds.length !== ids.size || caseIds.some((id) => !ids.has(id))) throw new Error("Baseline question set mismatch");
  if (rows.some((row) => typeof row.correct !== "boolean" || row.error !== null || typeof row.premise_override !== "boolean")) throw new Error("Baseline contains an unscored or malformed row");
  if (typeof report.generation_blinding !== "string" || !report.generation_blinding) throw new Error("Baseline neutral-generation statement missing");
  for (const [key, value] of Object.entries(BASELINE_INVOCATION)) if (report.invocation?.[key] !== value) throw new Error(`Baseline invocation differs: ${key}`);
}

export function verifySources(cases: Case[], rankById: Map<string, Ranking>, provenance: Record<string, unknown>, rankingDataset: unknown): void {
  for (const item of cases) {
    const ranking = rankById.get(item.question_id);
    if (!ranking) throw new Error("Ranking missing for selected question");
    if (ranking.retrieved_session_occurrences === undefined) throw new Error("Exact ranking occurrences required");
    if (ranking.source_sha256 !== undefined) {
      if (ranking.source_sha256 !== questionSourcesHash(item.question, item.sessions)) throw new Error("Ranking source fingerprint mismatch");
    } else if (typeof provenance.dataset_sha256 !== "string" || provenance.dataset_sha256 !== rankingDataset) throw new Error("Ranking source fingerprint unverifiable");
  }
}

/** Original E5 top 18 plus the first two distinct lexical occurrences outside those 18. */
export function refreshSources(item: Case, ranking: Ranking) {
  const original = cachedRank(item.sessions, ranking.retrieved_session_ids, 20, ranking.retrieved_session_occurrences);
  if (original.length !== 20) throw new Error("original_ranking_incomplete");
  const kept = original.slice(0, REPLAY.retained);
  const have = new Set(kept.map((row) => row.occurrence));
  const added = lexicalRank(item.question, item.sessions, REPLAY.lexicalLimit).filter((row) => !have.has(row.occurrence)).slice(0, REPLAY.reserve);
  if (added.length < REPLAY.reserve) throw new Error("lexical_reserve_insufficient");
  return { original, kept, added, dropped: original.slice(REPLAY.retained), ranked: [...kept, ...added] };
}

const coverage = (item: Case, rows: Ranked[]): Coverage => {
  if (!item.gold_session_ids.length) return { any: null, all: null };
  const ids = new Set(rows.map((row) => row.id));
  return { any: item.gold_session_ids.some((id) => ids.has(id)), all: item.gold_session_ids.every((id) => ids.has(id)) };
};

/** True when a model-facing prompt carries a question ID, gold session ID or source ID. */
export function leaksIdentifiers(prompt: string, item: Case, ranked: Ranked[]): boolean {
  return [item.question_id, ...item.gold_session_ids, ...ranked.map((row) => row.id)].some((id) => id.length >= 6 && prompt.includes(id));
}

export function prepareCase(item: Case, base: BaselineRow, ranking: Ranking): { row: ReplayRow; prompt: string | null } {
  const row: ReplayRow = {
    question_id: item.question_id, question_type: item.question_type, is_abstention: item.is_abstention,
    baseline_correct: base.correct, baseline_answer: base.answer, draft_answer: base.draft_answer ?? null, evidence: null,
    source_changes: null, gold_coverage: null, review_prompt_sha256: null, review_call: null, review_answer: null,
    judge_call: null, replay_correct: null, error: null,
  };
  try {
    const refreshed = refreshSources(item, ranking);
    const render = (rows: Ranked[]) => buildSupplementalEvidence(rows, item.question, REPLAY.contextChars, false);
    if (render(refreshed.original).text !== base.evidence?.text) throw new Error("baseline_evidence_not_reproduced");
    const evidence = render(refreshed.ranked);
    if (!("supplemental" in evidence)) throw new Error("supplemental_diagnostics_missing");
    row.evidence = evidence;
    const occ = (rows: Ranked[]) => rows.map((entry) => entry.occurrence);
    const before = new Set(occ(refreshed.original)), after = new Set(occ(refreshed.ranked));
    // Lexical selections may reselect an original tail source; added/dropped are true set differences against the original 20.
    row.source_changes = {
      retained_occurrences: occ(refreshed.kept), lexical_tail_selections: occ(refreshed.added),
      added_occurrences: occ(refreshed.ranked).filter((n) => !before.has(n)),
      dropped_occurrences: occ(refreshed.original).filter((n) => !after.has(n)),
    };
    row.gold_coverage = { baseline: coverage(item, refreshed.original), refreshed: coverage(item, refreshed.ranked) };
    if (typeof base.draft_answer !== "string" || !base.draft_answer.trim()) throw new Error("baseline_draft_missing");
    const prompt = groundedAnswerReviewPrompt(
      item.question, answerGenerationClock(item.answer_prompt_prefix), evidence.text, base.draft_answer, answerTaskContract(item.answer_prompt_prefix),
    );
    if (leaksIdentifiers(prompt, item, refreshed.ranked)) throw new Error("review_prompt_leaks_identifiers");
    row.review_prompt_sha256 = sha256(prompt);
    return { row, prompt };
  } catch (error) {
    row.error = error instanceof Error ? error.message.slice(0, 80) : "prepare_failed";
    return { row, prompt: null };
  }
}

/** One review call, then one fixed judge call. No retries, no rejudging; any failure is kept as the row's error. */
export async function replayCase(prepared: { row: ReplayRow; prompt: string | null }, item: Case, call: ModelCall): Promise<ReplayRow> {
  const { row, prompt } = prepared;
  if (row.error || prompt === null) return row;
  try {
    row.review_call = await call("answer", prompt);
    if (row.review_call.error) { row.error = `review_${row.review_call.error}`; return row; }
    row.review_answer = parseAnswer(row.review_call.text);
    if (row.review_answer === null) { row.error = "malformed_review"; return row; }
    row.judge_call = await call("judge", judgePrompt(item, row.review_answer));
    if (row.judge_call.error) { row.error = `judge_${row.judge_call.error}`; return row; }
    const verdict = parseJudge(row.judge_call.text);
    if (verdict === null) { row.error = "malformed_judge"; return row; }
    row.replay_correct = verdict;
  } catch (error) { row.error = safeError(error); }
  return row;
}

/** Native Qwen configuration: strict JSON, medium review reasoning, 8192 tokens, bounded native transport. */
export function buildModelCall(fetcher: (url: string, init: RequestInit) => Promise<Response> = longRequestFetch): ModelCall {
  return createModelCall("qwen-local", fetcher, {
    structuredOutput: true, reasoningEffort: "medium", maxOutputTokens: REPLAY.reviewTokens, answerInstructions: ANSWER_INSTRUCTIONS,
  });
}

const isUsage = (usage: Record<string, unknown> | null) => typeof usage?.input_tokens === "number" && typeof usage.output_tokens === "number";

function journaled(call: ModelCall, questionId: string, record: (entry: Unsequenced) => number): ModelCall {
  return async (kind, prompt, meta) => {
    const start_seq = record({ event: "start", at: new Date().toISOString(), question_id: questionId, kind, prompt_sha256: sha256(prompt) });
    try {
      const result = await call(kind, prompt, meta);
      record({ event: "finish", start_seq, at: new Date().toISOString(), question_id: questionId, kind, prompt_sha256: result.prompt_sha256, model: result.model,
        error: result.error, attempts: result.attempts, elapsed_ms: result.elapsed_ms, usage_known: isUsage(result.usage), usage: result.usage,
        request_config: result.request_config ?? null });
      return result;
    } catch (error) {
      record({ event: "finish", start_seq, at: new Date().toISOString(), question_id: questionId, kind, prompt_sha256: sha256(prompt), model: "unknown",
        error: safeError(error), attempts: 0, elapsed_ms: 0, usage_known: false, usage: null, request_config: null });
      throw error;
    }
  };
}

/**
 * Counts logical adapter calls and the HTTP attempts behind them. The adapter reports usage only for its final attempt,
 * so usage of earlier attempts is unknown, never zero; known token totals are therefore a lower bound.
 */
export function usageSummary(journal: JournalEntry[]) {
  const starts = journal.filter((e): e is JournalStart => e.event === "start");
  const finished = journal.filter((e): e is JournalFinish => e.event === "finish");
  const tokens = { input: 0, output: 0 };
  for (const entry of finished) if (entry.usage_known) {
    tokens.input += entry.usage!.input_tokens as number;
    tokens.output += entry.usage!.output_tokens as number;
  }
  const priorUnmetered = finished.reduce((n, e) => n + Math.max(0, e.attempts - 1), 0);
  const unknownFinal = finished.filter((e) => !e.usage_known).length;
  return {
    logical_calls_started: starts.length, logical_calls_finished: finished.length, logical_calls_unfinished: starts.length - finished.length,
    http_attempts: finished.reduce((n, e) => n + e.attempts, 0), calls_with_internal_retries: finished.filter((e) => e.attempts > 1).length,
    prior_attempts_with_unknown_usage: priorUnmetered, failed_calls: finished.filter((e) => e.error).length,
    final_attempts_with_unknown_usage: unknownFinal, usage_complete: priorUnmetered === 0 && unknownFinal === 0 && starts.length === finished.length,
    known_tokens_lower_bound: tokens, elapsed_ms: finished.reduce((n, e) => n + e.elapsed_ms, 0),
    by_kind: Object.fromEntries([...new Set(finished.map((e) => e.kind))].map((kind) => [kind, finished.filter((e) => e.kind === kind).length])),
  };
}

/**
 * 500-row mixed score. Only rows outside the selected cohort reuse their historical verdict. A selected row counts
 * as correct only with a successful replay verdict; an error, malformed output or missing row counts incorrect.
 */
export function summarizeReplay(
  baselineRows: (Pick<BaselineRow, "question_id" | "correct"> & { premise_override?: boolean; is_abstention?: boolean })[],
  rows: ReplayRow[], expectedReplays: number, target: number = REPLAY.targetCorrect,
) {
  const byId = new Map<string, ReplayRow>();
  const duplicates: string[] = [];
  for (const row of rows) { if (byId.has(row.question_id)) duplicates.push(row.question_id); else byId.set(row.question_id, row); }
  const baseIds = new Set(baselineRows.map((row) => row.question_id));
  // The canonical cohort is the baseline's own premise-override set; supplied rows define it only for fixtures without flags.
  const flagged = baselineRows.filter((row) => row.premise_override === true).map((row) => row.question_id);
  const cohort = new Set(flagged.length ? flagged : rows.map((row) => row.question_id).filter((id) => baseIds.has(id)));
  const unknownIds = [...byId.keys()].filter((id) => !cohort.has(id));
  const missingIds = [...cohort].filter((id) => !byId.has(id));
  const final = (id: string) => byId.get(id)?.replay_correct === true; // failed, malformed or missing selected rows are incorrect
  const mixed = baselineRows.filter((row) => cohort.has(row.question_id) ? final(row.question_id) : row.correct).length;
  const selectedBase = baselineRows.filter((row) => cohort.has(row.question_id));
  const uncounted = selectedBase.filter((row) => !final(row.question_id)).map((row) => row.question_id);
  const gains = selectedBase.filter((row) => !row.correct && final(row.question_id)).map((row) => row.question_id);
  const lossRows = selectedBase.filter((row) => row.correct && !final(row.question_id));
  const losses = lossRows.map((row) => row.question_id);
  const abstentionLosses = lossRows.filter((row) => row.is_abstention ?? byId.get(row.question_id)?.is_abstention === true).map((row) => row.question_id);
  const baselineCorrect = baselineRows.filter((row) => row.correct).length;
  const errors = rows.filter((row) => row.error);
  const unfinished = rows.filter((row) => !row.error && row.replay_correct === null).length;
  const complete = rows.length === expectedReplays && cohort.size === expectedReplays && !duplicates.length && !unknownIds.length
    && !missingIds.length && !errors.length && !unfinished;
  const passed = complete && mixed >= target && !abstentionLosses.length;
  return {
    planned: baselineRows.length, reused: baselineRows.length - cohort.size, replayed: rows.length, expected_replays: expectedReplays,
    baseline_correct: baselineCorrect, mixed_correct: mixed, delta_vs_baseline: mixed - baselineCorrect, target_correct: target,
    gains, losses, net: gains.length - losses.length, abstention_losses: abstentionLosses, unfinished,
    duplicate_ids: duplicates, unknown_ids: unknownIds, missing_ids: missingIds,
    errors: errors.length, errors_by_kind: Object.fromEntries([...new Set(errors.map((r) => r.error!))].map((e) => [e, errors.filter((r) => r.error === e).length])),
    selected_without_correct_verdict: uncounted, failed_replay_ids: errors.map((row) => row.question_id),
    advancement_screen_passed: passed, status: !complete ? "incomplete" : passed ? "pending_source_review" : "screen_not_passed",
    claim: "Mixed saved-answer replay: historical verdicts outside the selected cohort plus the reviewed cohort. Selected rows without a successful verdict count incorrect. Not a fresh full500 run and not a headline score.",
  };
}

function codeHashes() {
  const files = [fileURLToPath(import.meta.url), ...CODE_FILES.map((path) => fileURLToPath(new URL(path, import.meta.url)))];
  return Object.fromEntries(files.map((path) => [path, sha256(readFileSync(path))]));
}

export async function runReplay(options: ReplayOptions, injectedCall?: ModelCall) {
  const sidecars = [options.out, `${options.out}.jsonl`, `${options.out}.journal.jsonl`, `${options.out}.progress.json`];
  if (sidecars.some((path) => existsSync(path))) throw new Error("Output already exists; choose a new path");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > REPLAY.maxConcurrency) throw new Error("Concurrency must be 1 to 3");
  // Non-injected live evidence must use the protocol's pinned baseline, question count and target; overrides are for offline tests.
  const protocolRun = options.live && injectedCall === undefined;
  if (protocolRun && ((options.expectedQuestions ?? REPLAY.questions) !== REPLAY.questions || (options.target ?? REPLAY.targetCorrect) !== REPLAY.targetCorrect
    || (options.baselineSha256 ?? BASELINE_SHA256) !== BASELINE_SHA256)) throw new Error("Live runs must use the protocol baseline, question count and target");
  const pinnedSha = protocolRun ? BASELINE_SHA256 : options.baselineSha256;
  const bytes = { baseline: readFileSync(options.baseline), input: readFileSync(options.input), rankings: readFileSync(options.rankings) };
  const baseline = JSON.parse(bytes.baseline.toString()) as BaselineReport;
  const input = JSON.parse(bytes.input.toString()) as { provenance: Record<string, unknown>; cases: Case[] };
  const rankingFile = JSON.parse(bytes.rankings.toString()) as { status?: string; dataset_sha256?: unknown; results: Ranking[] };
  if (rankingFile.status !== "complete" || !Array.isArray(rankingFile.results)) throw new Error("Ranking report is incomplete");
  const cases = selectCases(input.cases, rankingFile.results);
  const hashes = { baseline: sha256(bytes.baseline), input: sha256(bytes.input), rankings: sha256(bytes.rankings) };
  validateBaseline(baseline, hashes, cases.map((item) => item.question_id), { sha256: pinnedSha, questions: options.expectedQuestions ?? REPLAY.questions });
  const caseById = new Map(cases.map((item) => [item.question_id, item]));
  const rankById = new Map(rankingFile.results.map((row) => [row.question_id, row]));
  const selected = baseline.results.filter((row) => row.premise_override === true); // selected only by the model's own output
  if (!selected.length) throw new Error("No premise-override rows selected");
  if (protocolRun && selected.length !== REPLAY.overrides) throw new Error("Live runs require exactly the 29 protocol premise-override rows");
  verifySources(selected.map((row) => caseById.get(row.question_id)!), rankById, input.provenance, rankingFile.dataset_sha256);
  const prepared = selected.map((base) => prepareCase(caseById.get(base.question_id)!, base, rankById.get(base.question_id)!));
  const prepareErrors = prepared.filter((entry) => entry.row.error).length;
  const executing = options.live || injectedCall !== undefined;
  const mode = injectedCall ? "injected_test" : options.live ? "live" : "prepare";
  const common = {
    mode, mixed_saved_answer_replay: true, fresh_full500: false, started_at: new Date().toISOString(), runtime: process.version,
    hashes: { ...hashes, code: codeHashes(), package_lock: sha256(readFileSync(fileURLToPath(new URL("../package-lock.json", import.meta.url)))) },
    selection: { rule: "baseline premise_override === true, regardless of correctness, reference, category or abstention label", count: selected.length, question_ids: selected.map((r) => r.question_id) },
    invocation: {
      provider: "qwen-local", request_mode: "robust", structured_output: true, concurrency: options.concurrency,
      review: { reasoning_effort: "medium", max_output_tokens: REPLAY.reviewTokens }, judge: { reasoning_effort: "none", max_output_tokens: REPLAY.judgeTokens },
      deadline_ms: REPLAY.timeoutMs, manual_retries: 0, retrieval: { retained: REPLAY.retained, lexical_reserve: REPLAY.reserve, lexical_limit: REPLAY.lexicalLimit, context_chars: REPLAY.contextChars },
    },
    answer_instructions: { sha256: sha256(ANSWER_INSTRUCTIONS), history_sha256: sha256(HISTORY_EVIDENCE_POLICY), minimal_sha256: sha256(MINIMAL_ANSWER_POLICY) },
    baseline_generation_blinding: baseline.generation_blinding,
    blinding: "Review and judge calls carry no question ID, abstention flag, correctness, gold session ID or source ID. References enter only the judge prompt; source changes and gold coverage are scorer-side diagnostics.",
  };
  if (!executing) {
    const rows = prepared.map((entry) => entry.row);
    const report = { status: prepareErrors ? "prepare_failed" : "prepared", comparison_valid: false, ...common, finished_at: new Date().toISOString(),
      summary: { selected: rows.length, prepare_errors: prepareErrors }, results: rows };
    writeFileSync(options.out, `${JSON.stringify(report)}\n`, { flag: "wx" });
    return report;
  }
  if (prepareErrors) throw new Error("Preparation failed; run without --live to inspect the errors");
  const journal: JournalEntry[] = [];
  const [jsonl, journalPath, progress] = sidecars.slice(1) as [string, string, string];
  // Reserve every output path exclusively before credentials are read or any call is made.
  writeFileSync(options.out, JSON.stringify({ status: "partial", comparison_valid: false, ...common }), { flag: "wx" });
  writeFileSync(jsonl, "", { flag: "wx" });
  writeFileSync(journalPath, "", { flag: "wx" });
  writeFileSync(progress, JSON.stringify({ status: "reserved" }), { flag: "wx" });
  let call: ModelCall;
  try { call = injectedCall ?? buildModelCall(); } catch (error) {
    writeFileSync(options.out, `${JSON.stringify({ status: "setup_failed", comparison_valid: false, ...common, error: error instanceof Error ? error.message.slice(0, 120) : "setup_failed" })}\n`);
    throw error;
  }
  const rows: (ReplayRow | undefined)[] = new Array(prepared.length);
  const record = (entry: Unsequenced): number => {
    const full = { seq: journal.length, ...entry } as JournalEntry;
    journal.push(full);
    appendFileSync(journalPath, `${JSON.stringify(full)}\n`);
    return full.seq;
  };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(options.concurrency, prepared.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= prepared.length) return;
      const item = caseById.get(selected[index]!.question_id)!;
      const row = await replayCase(prepared[index]!, item, journaled(call, item.question_id, record));
      rows[index] = row;
      appendFileSync(jsonl, `${JSON.stringify({ index, ...row })}\n`);
      const done = rows.filter((entry): entry is ReplayRow => entry !== undefined);
      writeFileSync(progress, JSON.stringify({ status: "partial", recorded: done.length, planned: prepared.length, errors: done.filter((r) => r.error).length }));
    }
  }));
  const results = rows as ReplayRow[];
  const summary = summarizeReplay(baseline.results, results, selected.length, options.target);
  const report = {
    status: "complete", trial_status: summary.status, comparison_valid: !injectedCall && summary.errors === 0, ...common,
    finished_at: new Date().toISOString(), summary, usage: usageSummary(journal), results,
  };
  writeFileSync(options.out, `${JSON.stringify(report)}\n`);
  writeFileSync(progress, JSON.stringify({ status: "complete", summary }));
  return report;
}

export function parseArgs(args: string[]): ReplayOptions {
  const keys: Record<string, "baseline" | "input" | "rankings" | "out" | "concurrency"> = {
    "--baseline": "baseline", "--input": "input", "--rankings": "rankings", "--out": "out", "--concurrency": "concurrency",
  };
  const values: Record<string, string> = {};
  let live = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--live") { live = true; continue; }
    const key = keys[args[i]!], value = args[++i];
    if (!key || !value) throw new Error("Unknown or missing argument");
    values[key] = value;
  }
  for (const key of ["baseline", "input", "rankings", "out"]) if (!values[key]) throw new Error(`--${key} is required`);
  return { baseline: values.baseline!, input: values.input!, rankings: values.rankings!, out: values.out!, live, concurrency: Number(values.concurrency ?? REPLAY.maxConcurrency) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runReplay({ ...parseArgs(process.argv.slice(2)), baselineSha256: BASELINE_SHA256 }).then((report) => {
    console.log(JSON.stringify(report.summary));
    if ("trial_status" in report && report.summary && "errors" in report.summary && report.summary.errors) process.exitCode = 1;
  }).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Replay failed"); process.exitCode = 1; });
}
