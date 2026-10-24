/** Reproducible offline answer evaluation; never writes to the user's Recall database. */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildFocusedEvidence } from "./longmemeval-focused-evidence.js";
import { buildHighlightedEvidence } from "./longmemeval-highlighted-evidence.js";
import { buildSupplementalEvidence } from "./longmemeval-supplemental-evidence.js";
import {
  ADDITIVE_LIMITATION, additiveCodePaths, additiveCoveredIds, additiveEvidence, additiveReport,
  validateAdditiveOptions, validateAdditiveRankings, type AdditiveEvidence, type additiveDiagnostics,
} from "./longmemeval-additive-qa.js";
import {
  STATEMENT_LIMITATION, statementCodePaths, statementCoveredIds, statementEvidence, statementReport,
  attachSourceTurns, validateStatementOptions, validateStatementRankings, type StatementEvidence, type statementDiagnostics,
} from "./longmemeval-statement-qa.js";
import { createAzureComposedCall, prepareAzureAnswer } from "./longmemeval-azure-qa.js";
import { longRequestFetch } from "./longmemeval-qa-transport.js";
import { answerGenerationClock, answerTaskContract, groundedAnswerReviewPrompt } from "./longmemeval-answer-review.js";
import {
  ledgerPrompt, ledgerSection, packedIndexPrompt, packedIndexSection, packUnitIndex,
  unitIndexPrompt, unitIndexSection, validateLedger, validatePackedIndex,
  validateUnitIndex, visibleUnits, type PackedIndexDiagnostics, type ValidatedLedger,
  type ValidatedPackedIndex, type ValidatedUnitIndex,
} from "./longmemeval-evidence-ledger.js";
import { questionSourcesHash } from "./longmemeval-source-identity.js";
import { HISTORY_EVIDENCE_POLICY } from "../src/history/evidence-policy.js";
import { MINIMAL_ANSWER_POLICY, MINIMAL_ANSWER_POLICY_V2 } from "./longmemeval-minimal-answer-policy.js";
import { PREMISE_CHECK_POLICY } from "./longmemeval-premise-policy.js";
import { premiseAbstention, premiseCheckPrompt } from "./longmemeval-premise-check.js";
import { answerOnce, sampleAnswers, withTransportRetry } from "./longmemeval-answer-sampling.js";
import {
  answerPrompt, buildEvidence, cachedRank, createModelCall, judgePrompt, lexicalRank,
  parseAnswer, parseJudge, parseObject, safeError, selectCases, sha256,
  type Call, type Case, type ModelCall, type Provider, type Ranking,
} from "./longmemeval-qa-support.js";

export const PACKED_ANSWER_FINALIZATION_GUIDANCE = "The answer field is the sole user-delivered and judged response. State the requested result and essential supporting facts in that field, rather than only in reasoning. For counts, identify counted instances and their supported states. Preserve genuine ambiguity: use a primary interpretation only when evidence supports it, state assumptions and retain equally supported alternatives. Do not force certainty, discard contrary updates, or manufacture a result to fit an expected reference.";

export type Options = {
  input: string; out: string; provider?: Provider; retrieval: "lexical" | "cached";
  rankings?: string; limit?: number; concurrency: number; contextChars: number; topK: number;
  evidence?: "prefix" | "focused" | "highlighted" | "supplemental" | "additive" | "statements"; requestMode?: "standard" | "robust";
  answerProvider?: "azure";
  answerCheck?: "none" | "grounded" | "premise";
  reasoningEffort?: "none" | "low" | "medium" | "high" | "adaptive"; maxOutputTokens?: number;
  evidencePolicy?: "inline" | "system";
  evidenceLedger?: "none" | "quoted" | "units" | "packed";
  answerPolicy?: "history" | "minimal" | "minimal-v2" | "premise" | "minimal-premise";
  answerRecovery?: "none" | "lower-effort" | "lower-effort-transport" | "longer-timeout-transport";
  answerSamples?: number; sourceTurns?: string;
};
export type Row = {
  question_id: string; question_type: string; is_abstention: boolean;
  evidence: ReturnType<typeof buildEvidence> | ReturnType<typeof buildFocusedEvidence> | ReturnType<typeof buildHighlightedEvidence> | ReturnType<typeof buildSupplementalEvidence> | AdditiveEvidence | StatementEvidence | null; retrieval_ms: number;
  answer_call: Call | null; judge_call: Call | null; answer: string | null;
  correct: boolean | null; error: string | null; gold_any: boolean | null; gold_all: boolean | null;
  cached_ambiguous_session_ids: string[];
  draft_answer?: string | null; review_call?: Call | null;
  premise_call?: Call | null; premise_recorded?: boolean | null; premise_override?: boolean;
  failed_answer_call?: Call | null; answer_recovered?: boolean;
  answer_samples?: Record<string, unknown>;
  exact_ranking_occurrences?: boolean;
  ledger_call?: Call | null;
  validated_ledger?: ValidatedLedger | ValidatedUnitIndex | ValidatedPackedIndex | null;
  ledger_chars?: number;
  final_answer_prompt_sha256?: string | null;
  ledger_format?: "units" | "packed";
  ledger_index_chars?: number;
  ledger_index_sha256?: string | null;
  packed_index_diagnostics?: PackedIndexDiagnostics;
  answer_format?: "standalone_packed";
  answer_format_sha256?: string;
  supplemental_diagnostics?: {
    included_ranks: number[];
    omitted: { source_rank: number; reason: "no_complete_unit" | "budget" }[];
  };
  additive_diagnostics?: ReturnType<typeof additiveDiagnostics>;
  statements_diagnostics?: ReturnType<typeof statementDiagnostics>;
};
export function summarize(rows: Row[], planned: number) {
  const completed = rows.filter((row) => row.correct !== null);
  const correct = completed.filter((row) => row.correct).length;
  const group = (items: Row[]) => ({
    questions: items.length, correct: items.filter((row) => row.correct).length,
    accuracy: items.length ? items.filter((row) => row.correct).length / items.length : null,
  });
  return {
    planned, recorded: rows.length, scored: completed.length, correct,
    accuracy: completed.length ? correct / planned : null,
    errors: rows.filter((row) => row.error).length,
    errors_by_kind: Object.fromEntries([...new Set(rows.flatMap((row) => row.error ? [row.error] : []))].map((error) => [error, rows.filter((row) => row.error === error).length])),
    by_type: Object.fromEntries([...new Set(completed.map((row) => row.question_type))].map((type) => [type, group(completed.filter((row) => row.question_type === type))])),
    abstention: group(completed.filter((row) => row.is_abstention)),
    answerable: group(completed.filter((row) => !row.is_abstention)),
    truncated_questions: rows.filter((row) => row.evidence?.sources.some((source) => source.truncated)).length,
    cached_ambiguous_questions: rows.filter((row) => row.cached_ambiguous_session_ids.length > 0).length,
    retrieval_gold_any: group(rows.filter((row) => row.gold_any !== null).map((row) => ({ ...row, correct: row.gold_any }))),
    retrieval_gold_all: group(rows.filter((row) => row.gold_all !== null).map((row) => ({ ...row, correct: row.gold_all }))),
  };
}

export async function evaluateCase(item: Case, options: Pick<Options, "retrieval" | "topK" | "contextChars" | "evidence" | "answerCheck" | "evidencePolicy" | "evidenceLedger" | "answerRecovery" | "answerSamples">, ids?: string[], call?: ModelCall, occurrences?: number[]): Promise<Row> {
  const row: Row = { question_id: item.question_id, question_type: item.question_type, is_abstention: item.is_abstention, evidence: null, retrieval_ms: 0, answer_call: null, judge_call: null, answer: null, correct: call ? false : null, error: null, gold_any: null, gold_all: null, cached_ambiguous_session_ids: [] };
  if (call && options.answerRecovery?.endsWith("-transport")) call = withTransportRetry(call);
  if (options.evidenceLedger === "quoted") Object.assign(row, {
    ledger_call: null, validated_ledger: null, ledger_chars: 0, final_answer_prompt_sha256: null,
  });
  if (options.evidenceLedger === "units") Object.assign(row, {
    ledger_call: null, validated_ledger: null, ledger_chars: 0, final_answer_prompt_sha256: null,
    ledger_format: "units", ledger_index_chars: 0, ledger_index_sha256: null,
  });
  if (options.evidenceLedger === "packed") Object.assign(row, {
    ledger_call: null, validated_ledger: null, ledger_chars: 0, final_answer_prompt_sha256: null,
    ledger_format: "packed", ledger_index_chars: 0, ledger_index_sha256: null,
    answer_format: "standalone_packed", answer_format_sha256: sha256(PACKED_ANSWER_FINALIZATION_GUIDANCE),
  });
  try {
    if (options.retrieval === "cached") {
      row.exact_ranking_occurrences = occurrences !== undefined;
      if (occurrences === undefined) row.cached_ambiguous_session_ids = [...new Set(ids ?? [])].filter((id) => item.sessions.filter((session) => session.id === id).length > 1);
    }
    const start = Date.now();
    const ranked = options.retrieval === "cached" ? cachedRank(item.sessions, ids ?? [], options.topK, occurrences) : lexicalRank(item.question, item.sessions, options.topK);
    row.retrieval_ms = Date.now() - start;
    if (options.evidence === "supplemental" && ranked.length !== 20) {
      row.error = "supplemental_ranking_incomplete";
      return row;
    }
    if (options.evidence === "additive") {
      const additive = additiveEvidence(item, ranked, occurrences !== undefined);
      row.retrieval_ms = Date.now() - start;
      if ("error" in additive) { row.error = additive.error; return row; }
      row.evidence = additive.evidence;
      row.supplemental_diagnostics = additive.evidence.supplemental;
      row.additive_diagnostics = additive.diagnostics;
    } else if (options.evidence === "statements") {
      const statements = statementEvidence(item, ranked, occurrences !== undefined);
      row.retrieval_ms = Date.now() - start;
      if ("error" in statements) { row.error = statements.error; return row; }
      row.evidence = statements.evidence;
      row.statements_diagnostics = statements.diagnostics;
    } else if (options.evidence === "supplemental") {
      const evidence = buildSupplementalEvidence(
        ranked,
        item.question,
        options.contextChars,
        options.evidencePolicy !== "system",
      );
      if (!("supplemental" in evidence)) throw new Error("Supplemental evidence diagnostics missing");
      row.evidence = evidence;
      row.supplemental_diagnostics = evidence.supplemental;
    } else {
      row.evidence = options.evidence === "highlighted"
        ? buildHighlightedEvidence(ranked, item.question, options.contextChars, options.evidencePolicy !== "system")
        : options.evidence === "focused"
          ? buildFocusedEvidence(ranked, item.question, options.contextChars, options.evidencePolicy !== "system")
          : buildEvidence(ranked, options.contextChars);
    }
    if (!item.is_abstention && item.gold_session_ids.length) {
      const retrieved = new Set(row.additive_diagnostics ? additiveCoveredIds(row.evidence) : row.statements_diagnostics ? statementCoveredIds(row.evidence) : ranked.map((source) => source.id));
      row.gold_any = item.gold_session_ids.some((id) => retrieved.has(id));
      row.gold_all = item.gold_session_ids.every((id) => retrieved.has(id));
    }
    if (!call) return row;
    let answerEvidence = row.evidence.text;
    if (options.evidenceLedger === "quoted") {
      const units = visibleUnits(ranked, row.evidence);
      row.ledger_call = await call("ledger", ledgerPrompt(item.question, answerGenerationClock(item.answer_prompt_prefix), units));
      if (row.ledger_call.error) { row.error = `ledger_${row.ledger_call.error}`; return row; }
      const ledger = validateLedger(row.ledger_call.text, units);
      if (!ledger) { row.error = "malformed_ledger"; return row; }
      const section = ledgerSection(ledger);
      if (!section) { row.error = "ledger_oversized"; return row; }
      row.validated_ledger = ledger;
      row.ledger_chars = section.chars;
      answerEvidence += section.text;
    }
    if (options.evidenceLedger === "units") {
      const units = visibleUnits(ranked, row.evidence);
      row.ledger_call = await call("ledger", unitIndexPrompt(item.question, answerGenerationClock(item.answer_prompt_prefix), units));
      if (row.ledger_call.error) { row.error = `ledger_${row.ledger_call.error}`; return row; }
      const index = validateUnitIndex(row.ledger_call.text, units);
      if (!index) { row.error = "malformed_ledger"; return row; }
      const section = unitIndexSection(index);
      if (!section) { row.error = "ledger_oversized"; return row; }
      row.validated_ledger = index;
      row.ledger_chars = section.chars;
      row.ledger_index_chars = section.chars;
      row.ledger_index_sha256 = section.sha256;
      answerEvidence += section.text;
    }
    if (options.evidenceLedger === "packed") {
      const units = visibleUnits(ranked, row.evidence);
      row.ledger_call = await call("ledger", packedIndexPrompt(item.question, answerGenerationClock(item.answer_prompt_prefix), units));
      if (row.ledger_call.error) { row.error = `ledger_${row.ledger_call.error}`; return row; }
      const parsed = validatePackedIndex(row.ledger_call.text, units);
      if (!parsed) { row.error = "malformed_ledger"; return row; }
      const index = packUnitIndex(parsed, units);
      if (!index) { row.error = "ledger_oversized"; return row; }
      const section = packedIndexSection(index);
      if (!section) { row.error = "ledger_oversized"; return row; }
      row.validated_ledger = index;
      row.ledger_chars = section.chars;
      row.ledger_index_chars = section.chars;
      row.ledger_index_sha256 = section.sha256;
      row.packed_index_diagnostics = index.diagnostics;
      answerEvidence += section.text;
    }
    const finalAnswerPrompt = answerPrompt(item, answerEvidence);
    if (options.evidenceLedger === "quoted" || options.evidenceLedger === "units" || options.evidenceLedger === "packed") row.final_answer_prompt_sha256 = sha256(finalAnswerPrompt);
    const sampled = (options.answerSamples ?? 1) > 1
      ? await sampleAnswers(call, finalAnswerPrompt, item.question, options.answerSamples!, options.answerRecovery)
      : null;
    const chosen = sampled ? sampled.runs[sampled.chosen]! : await answerOnce(call, finalAnswerPrompt, item.question, options.answerRecovery);
    row.answer_call = chosen.answerCall;
    if (chosen.failed) row.failed_answer_call = chosen.failed;
    if (chosen.recovered !== undefined) row.answer_recovered = chosen.recovered;
    if (sampled) row.answer_samples = {
      chosen: sampled.chosen, votes: sampled.votes, answers: sampled.answers,
      calls: sampled.runs.map((run) => run.answerCall), failed_calls: sampled.runs.map((run) => run.failed),
      agreements: sampled.agreements,
    };
    if (row.answer_call.error) { row.error = `answer_${row.answer_call.error}`; return row; }
    row.answer = parseAnswer(row.answer_call.text);
    if (row.answer === null) { row.error = "malformed_answer"; return row; }
    if (options.answerCheck === "grounded") {
      row.draft_answer = row.answer;
      row.review_call = await call("answer", groundedAnswerReviewPrompt(
        item.question, answerGenerationClock(item.answer_prompt_prefix), row.evidence.text, row.answer,
        answerTaskContract(item.answer_prompt_prefix),
      ), { question: item.question });
      if (row.review_call.error) { row.answer = null; row.error = `review_${row.review_call.error}`; return row; }
      row.answer = parseAnswer(row.review_call.text);
      if (row.answer === null) { row.error = "malformed_review"; return row; }
    }
    if (options.answerCheck === "premise") {
      row.draft_answer = row.answer;
      row.premise_override = false;
      row.premise_call = await call("premise", premiseCheckPrompt(item.question, answerGenerationClock(item.answer_prompt_prefix), row.evidence.text));
      const check = row.premise_call.error ? null : parseObject(row.premise_call.text);
      row.premise_recorded = typeof check?.correct === "boolean" ? check.correct : null;
      if (row.premise_recorded === false) {
        row.answer = premiseAbstention(typeof check?.reason === "string" ? check.reason : "");
        row.premise_override = true;
      }
    }
    row.judge_call = await call("judge", judgePrompt(item, row.answer));
    if (row.judge_call.error) { row.error = `judge_${row.judge_call.error}`; return row; }
    const verdict = parseJudge(row.judge_call.text);
    if (verdict === null) { row.error = "malformed_judge"; return row; }
    row.correct = verdict;
    return row;
  } catch (error) { row.error = safeError(error); return row; }
}

export async function runEvaluation(options: Options, injectedCall?: ModelCall) {
  if (existsSync(options.out) || existsSync(`${options.out}.jsonl`) || existsSync(`${options.out}.progress.json`)) throw new Error("Output already exists; choose a new path");
  for (const n of [options.concurrency, options.contextChars, options.topK, ...(options.limit === undefined ? [] : [options.limit]), ...(options.maxOutputTokens === undefined ? [] : [options.maxOutputTokens])]) if (!Number.isInteger(n) || n < 1) throw new Error("Options must be positive integers");
  if (options.concurrency > 6) throw new Error("Concurrency must be at most six");
  if (options.answerProvider && options.answerProvider !== "azure") throw new Error("Invalid answer provider");
  if (options.retrieval === "cached" && !options.rankings) throw new Error("Cached retrieval requires --rankings");
  if (options.retrieval === "lexical" && options.rankings) throw new Error("--rankings requires cached retrieval");
  const azurePreparationOnly = options.answerProvider === "azure" && options.provider === undefined && injectedCall === undefined;
  if (options.requestMode === "robust" && options.provider !== "qwen-local" && !injectedCall && !azurePreparationOnly) throw new Error("Robust requests currently require qwen-local");
  if (options.reasoningEffort === "adaptive" && options.provider !== "qwen-local" && !azurePreparationOnly) throw new Error("Adaptive reasoning requires qwen-local");
  if (options.reasoningEffort === "adaptive" && options.maxOutputTokens === undefined) throw new Error("Adaptive reasoning requires --max-output-tokens");
  if ((options.reasoningEffort || options.maxOutputTokens) && options.provider !== "qwen-local" && !injectedCall && !azurePreparationOnly) throw new Error("Reasoning and output overrides currently require qwen-local");
  if (options.evidencePolicy === "system" && options.provider && options.provider !== "qwen-local") throw new Error("System evidence policy currently requires qwen-local");
  if (options.answerPolicy && options.answerPolicy !== "history") {
    if (options.evidencePolicy !== "system") throw new Error("Non-default answer policy requires system evidence policy");
    if (options.evidenceLedger && options.evidenceLedger !== "none") throw new Error("Non-default answer policy cannot use an evidence ledger");
    if (options.answerCheck === "grounded") throw new Error("Non-default answer policy cannot use grounded answer checks");
    if (options.answerProvider) throw new Error("Non-default answer policy requires the Qwen answer path");
  }
  if (options.evidence === "supplemental") {
    if (options.topK !== 20) throw new Error("Supplemental evidence requires --top-k 20");
    if (options.evidenceLedger && options.evidenceLedger !== "none") throw new Error("Supplemental evidence cannot use an evidence ledger");
    if (options.answerCheck === "grounded") throw new Error("Supplemental evidence cannot use grounded answer checks");
    if (options.concurrency > 3) throw new Error("Supplemental evidence concurrency must be at most three");
    const hasCalls = options.provider !== undefined || injectedCall !== undefined;
    if (hasCalls) {
      if (options.provider !== "qwen-local") throw new Error("Supplemental evidence requires qwen-local");
      if (options.requestMode !== "robust" || options.evidencePolicy !== "system") throw new Error("Supplemental evidence calls require robust requests and system evidence policy");
      if (options.reasoningEffort !== "adaptive" && options.reasoningEffort !== "high") throw new Error("Supplemental evidence calls require adaptive or explicit high reasoning");
      if (options.maxOutputTokens !== 16384) throw new Error("Supplemental evidence calls require a 16384-token answer budget");
    }
  }
  if (options.evidenceLedger === "quoted" || options.evidenceLedger === "units" || options.evidenceLedger === "packed") {
    if (options.answerCheck === "grounded") throw new Error("Evidence ledger cannot be combined with grounded answer checks");
    if (options.requestMode !== "robust" || options.evidencePolicy !== "system") throw new Error("Evidence ledger requires robust requests and system evidence policy");
    if (options.reasoningEffort !== "adaptive" || options.maxOutputTokens !== 16384) throw new Error("Evidence ledger requires adaptive reasoning and a 16384-token answer budget");
    if (options.concurrency > 3) throw new Error("Evidence ledger concurrency must be at most three");
    if (!injectedCall && options.provider !== "qwen-local") throw new Error("Evidence ledger requires qwen-local");
  }
  if (options.evidence === "additive") validateAdditiveOptions(options, options.provider !== undefined || injectedCall !== undefined);
  validateStatementOptions(options, options.provider !== undefined || injectedCall !== undefined);
  const azurePreparation = prepareAzureAnswer(
    options,
    options.provider !== undefined || injectedCall !== undefined,
  );
  const inputBytes = readFileSync(options.input);
  const input = JSON.parse(inputBytes.toString()) as { provenance: Record<string, unknown>; cases: Case[] };
  const rankingBytes = options.rankings ? readFileSync(options.rankings) : null;
  const rankingFile = rankingBytes ? JSON.parse(rankingBytes.toString()) as {
    status?: string; selected_question_ids?: string[]; dataset_sha256?: unknown; results: Ranking[];
  } : undefined;
  if (options.retrieval === "cached" && !Array.isArray(rankingFile?.results)) throw new Error("Ranking results missing");
  if (rankingFile?.status && rankingFile.status !== "complete") throw new Error("Ranking report is incomplete");
  const rankings = rankingFile?.results;
  if (rankingFile?.selected_question_ids) {
    const declared = new Set(rankingFile.selected_question_ids);
    if (declared.size !== rankingFile.selected_question_ids.length
      || rankings?.length !== declared.size
      || rankings.some((row) => !declared.has(row.question_id))) throw new Error("Ranking question identity mismatch");
  }
  let selected = selectCases(input.cases, rankings, options.limit);
  if (!selected.length) throw new Error("No questions selected");
  const sourceTurns = options.evidence === "statements" ? attachSourceTurns(options.sourceTurns!, input, inputBytes, selected) : undefined;
  if (sourceTurns) selected = sourceTurns.cases;
  const rankById = new Map(rankings?.map((row) => [row.question_id, row]));
  let sourceVerification: "per_question_hash" | "dataset_hash" | "unverified" = "unverified";
  if (options.retrieval === "cached") {
    const fingerprinted = selected.filter((item) => rankById.get(item.question_id)!.source_sha256 !== undefined);
    for (const item of fingerprinted) {
      const actual = questionSourcesHash(item.question, item.sessions);
      if (rankById.get(item.question_id)!.source_sha256 !== actual) {
        throw new Error("Ranking source fingerprint mismatch");
      }
    }
    if (fingerprinted.length === selected.length) {
      sourceVerification = "per_question_hash";
    } else if (!fingerprinted.length) {
      const inputDatasetHash = input.provenance.dataset_sha256;
      const rankingDatasetHash = rankingFile?.dataset_sha256;
      if (typeof inputDatasetHash === "string" && typeof rankingDatasetHash === "string") {
        if (inputDatasetHash !== rankingDatasetHash) throw new Error("Ranking dataset fingerprint mismatch");
        sourceVerification = "dataset_hash";
      }
    }
    for (const item of selected) {
      const ranking = rankById.get(item.question_id)!;
      cachedRank(item.sessions, ranking.retrieved_session_ids, options.topK, ranking.retrieved_session_occurrences);
    }
  }
  if (options.evidence === "additive") validateAdditiveRankings(rankById, selected);
  if (options.evidence === "statements") validateStatementRankings(rankById, selected);
  if (options.evidence === "supplemental") {
    for (const item of selected) {
      const ranking = rankById.get(item.question_id);
      const ranked = options.retrieval === "cached"
        ? cachedRank(item.sessions, ranking!.retrieved_session_ids, 20, ranking!.retrieved_session_occurrences)
        : lexicalRank(item.question, item.sessions, 20);
      if (ranked.length !== 20) throw new Error("Supplemental evidence requires exactly 20 ranked sources per selected question");
    }
  }
  const minimalPolicy = options.answerPolicy === "minimal-v2" ? MINIMAL_ANSWER_POLICY_V2 : MINIMAL_ANSWER_POLICY;
  const usesMinimal = options.answerPolicy === "minimal" || options.answerPolicy === "minimal-v2" || options.answerPolicy === "minimal-premise";
  const usesPremise = options.answerPolicy === "premise" || options.answerPolicy === "minimal-premise";
  const answerInstructions = options.evidencePolicy === "system"
    ? options.answerPolicy && options.answerPolicy !== "history"
      ? [HISTORY_EVIDENCE_POLICY, ...(usesMinimal ? [minimalPolicy] : []), ...(usesPremise ? [PREMISE_CHECK_POLICY] : [])].join("\n\n")
      : `${HISTORY_EVIDENCE_POLICY}${options.evidenceLedger === "packed" ? `\n\n${PACKED_ANSWER_FINALIZATION_GUIDANCE}` : ""}`
    : undefined;
  const qwenCall = injectedCall ?? (options.provider
    ? createModelCall(options.provider, options.requestMode === "robust" ? longRequestFetch : fetch,
      { structuredOutput: options.requestMode === "robust",
        reasoningEffort: options.reasoningEffort, maxOutputTokens: options.maxOutputTokens,
        answerInstructions,
        ledgerFormat: options.evidenceLedger === "units" ? "units" : options.evidenceLedger === "packed" ? "packed" : undefined })
    : undefined);
  const call = injectedCall ?? (azurePreparation && qwenCall
    ? createAzureComposedCall(azurePreparation, answerInstructions!, qwenCall)
    : qwenCall);
  const supplementalSourcePath = fileURLToPath(new URL("./longmemeval-supplemental-evidence.ts", import.meta.url));
  const azureSourcePaths = azurePreparation
    ? ["./longmemeval-azure-qa.ts", "./longmemeval-azure-answer.ts"]
      .map((path) => fileURLToPath(new URL(path, import.meta.url)))
    : [];
  const files = [
    fileURLToPath(import.meta.url),
    ...["./longmemeval-qa-support.ts", "./longmemeval-qa-transport.ts", "./longmemeval-focused-evidence.ts", "./longmemeval-highlighted-evidence.ts",
      "./longmemeval-evidence-ledger.ts", "./longmemeval-answer-review.ts", "./longmemeval-source-identity.ts", "./longmemeval-inference-policy.ts",
      "../src/history/evidence.ts", "../src/text/match.ts", "../src/vector/sqlite-fts.ts",
      "../src/history/evidence-policy.ts", "./longmemeval-minimal-answer-policy.ts", "./longmemeval-premise-policy.ts", "./longmemeval-premise-check.ts", "./longmemeval-answer-sampling.ts",
      "../src/vector/synonyms.ts", "../src/data/synonyms.en.json", "../src/models/retrieval-text.ts", "./temporal-model.ts"]
      .map((path) => fileURLToPath(new URL(path, import.meta.url))),
    ...(options.evidence === "supplemental" ? [supplementalSourcePath] : []),
    ...(options.evidence === "additive" ? additiveCodePaths() : []),
    ...(options.evidence === "statements" ? statementCodePaths() : []),
    ...azureSourcePaths,
  ];
  const report = {
    status: "partial", comparison_valid: !((options.evidence === "additive" || options.evidence === "statements") && injectedCall !== undefined), started_at: new Date().toISOString(), finished_at: null as string | null,
    invocation: options, runtime: process.version, provenance: input.provenance,
    hashes: { input: sha256(inputBytes), rankings: rankingBytes ? sha256(rankingBytes) : null, code: Object.fromEntries(files.map((path) => [path, sha256(readFileSync(path))])), package_lock: sha256(readFileSync(fileURLToPath(new URL("../package-lock.json", import.meta.url)))) },
    source_verification: sourceVerification,
    answer_instructions: answerInstructions === undefined ? null : {
      policy: options.answerPolicy ?? "history",
      sha256: sha256(answerInstructions),
      history_sha256: sha256(HISTORY_EVIDENCE_POLICY),
      minimal_sha256: usesMinimal ? sha256(minimalPolicy) : null,
      premise_sha256: usesPremise ? sha256(PREMISE_CHECK_POLICY) : null,
    },
    packed_answer_format: options.evidenceLedger === "packed"
      ? { answer_field: "standalone", guidance_sha256: sha256(PACKED_ANSWER_FINALIZATION_GUIDANCE) }
      : undefined,
    ...(options.evidence === "supplemental"
      ? { supplemental_evidence: {
        primary_source_limit: 10,
        supplemental_source_ranks: [11, 20],
        per_source_chars: 4000,
        renderer_source_sha256: sha256(readFileSync(supplementalSourcePath)),
        diagnostics: "Recorded in each result's supplemental_diagnostics field.",
      } }
      : {}),
    ...(options.evidence === "additive" ? { additive_evidence: additiveReport() } : {}),
    ...(options.evidence === "statements" ? { statement_evidence: statementReport(), source_turns_manifest: sourceTurns!.report } : {}),
    ...(azurePreparation
      ? { azure_answer_provider: {
        ...azurePreparation.metadata,
        source_sha256: sha256(readFileSync(azureSourcePaths[1]!)),
      } }
      : {}),
    selected_question_ids: selected.map((item) => item.question_id),
    generation_blinding: "Original source IDs, original occurrence positions, has_answer flags, reference answers and gold session-ID lists are hidden from the answering model. Evidence uses neutral numbered labels and date metadata only.",
    limitations: [
      "Exploratory local run, not an official LongMemEval submission or a matched Hindsight rerun.",
      options.retrieval === "lexical" ? "Fresh production FTS search only, with OR queries for chat. Vector retrieval, extraction, promotion and lifecycle delivery are outside this experiment." : "Supplied rankings use exact original source positions when present. Older ID-only rankings expand ambiguous duplicate IDs before top-k and can displace later IDs; affected questions are counted. Ranking-file provenance determines the retrieval configuration.",
      "Source text is raw role/content conversation history, not automatically extracted durable memories. Dataset has_answer flags never enter retrieval or generation.",
      options.evidence === "additive" ? ADDITIVE_LIMITATION
      : options.evidence === "statements" ? STATEMENT_LIMITATION
      : options.evidence === "supplemental"
        ? "Context preserves the original highlighted evidence for the first ten ranked sources unchanged, then uses only spare context budget for query-focused complete verbatim excerpts from ranks 11 through 20. Supplemental excerpts use neutral labels, observation dates and a 4000-character per-source ceiling; characters are not tokens and selection can omit useful text."
        : options.evidence === "highlighted"
        ? "Context retains original session evidence under the original character budget plus bounded verbatim query-focused previews. Neutral Memory N labels identify the same source in previews and full text. Coverage counts unique original characters, excluding duplicate preview text."
        : options.evidence === "focused"
        ? "Context uses the application's verbatim query-focused excerpt renderer with observation dates, a 4000-character per-source ceiling and explicit evidence-use guidance. Characters are not tokens; selection may omit useful text."
        : "Context uses ranked session prefixes with an evenly shared character budget; characters are not model tokens.",
      options.answerProvider === "azure"
        ? "Azure answer requests use the fixed strict Responses JSON schema and bounded native HTTP transport. The Qwen judge remains on its fixed configuration."
        : options.requestMode === "robust"
        ? "Robust Qwen requests use strict JSON schema output and a bounded native HTTP transport with the explicit 600-second deadline. This is a changed request configuration, not an exact baseline replay."
        : "Standard request transport and JSON instructions are retained.",
      options.answerCheck === "grounded"
        ? "Every successfully drafted answer receives one fixed additional grounding check using the question, reference clock, same evidence and draft only. The checker has no reference answer, gold labels or judge verdict. Both calls and the final answer are retained. This changes inference cost and does not describe ordinary Recall lifecycle behavior."
        : options.answerCheck === "premise"
        ? "After each successful answer, one low-reasoning premise check sees only the question, clock and the same evidence, never the draft or any reference. Only an explicit false verdict replaces the answer with a fixed not-recorded statement plus the checker's reason; check failures or malformed output keep the draft. Draft, check call and override are retained."
        : "Answers use one generation call without a separate grounding check.",
      options.answerRecovery && options.answerRecovery !== "none"
        ? `When an answer call ${options.answerRecovery === "longer-timeout-transport" ? "times out, exactly one more answer call is made at the same reasoning effort with a 1,200-second deadline; when it returns an incomplete response, exactly one more call is made" : "times out or returns an incomplete response, exactly one more answer call is made"} with the same prompt at the next lower reasoning effort (high or medium to low, low to none). The rule depends only on the error type, never on correctness; both calls are retained.${options.answerRecovery.endsWith("-transport") ? " Any answer, check or judge call that fails before reaching the model (request_failed) is repeated at the same settings up to three times, two minutes apart; failed attempts are kept in transport_failures." : ""}`
        : "Failed answer calls are not retried.",
      (options.answerSamples ?? 1) > 1
        ? `Each question gets ${options.answerSamples} independent answer calls with the same prompt and settings. Reasoning-none pairwise checks see only the question and two final answers and report whether their core results match; identical texts skip the check. The answer agreeing with the most others is used, ties go to the earliest sample. Selection never sees evidence, references or judge verdicts.`
        : "One answer sample per question.",
      ...(options.evidenceLedger === "quoted"
        ? ["Before each answer, one low-reasoning, bounded extractor selects only complete visible quoted turns by neutral rank and unit index. The harness validates references, reconstructs quotations and ranges, and rejects invalid or oversized ledgers before answering."]
        : options.evidenceLedger === "units"
        ? ["Before each answer, one low-reasoning extractor selects only complete visible source-turn references. The harness validates and materializes a bounded quoted reading index before answering."]
        : options.evidenceLedger === "packed"
        ? ["Before each answer, one low-reasoning extractor ranks complete visible source-turn references. The harness validates every reference, then deterministically packs whole quotations under a bounded reading-index budget."]
        : []),
      options.answerProvider === "azure"
        ? "Azure answers use fixed medium reasoning and a 16384-token output limit; the actual response model is retained in answer_call.model. Adaptive reasoning and the 16384-token option configure the Qwen base path, not Azure answer calls. Qwen judge reasoning remains none with a 4096-token limit."
        : `Qwen answer reasoning effort: ${options.reasoningEffort ?? "none"}; answer output limit: ${options.maxOutputTokens ?? 4096}. Judge reasoning remains none with a 4096-token limit; answer overrides change the inference configuration.`,
      options.evidencePolicy === "system"
        ? "The application's history evidence contract is delivered as an answer-system instruction instead of quoted source text. It is not added to the judge. This changes instruction placement and token accounting."
        : options.evidence === "supplemental"
        ? "Supplemental evidence includes the history evidence contract inline with the source context."
        : "Focused/highlighted modes include evidence-use guidance inline in the source context.",
      "Duplicate source IDs retain separate occurrences internally. Exact ranked positions are validated against original IDs and never enter generation; ID-only legacy caches expand occurrences before top-k. Dates and future sessions are preserved. Generation sees neutral labels.",
      options.answerProvider === "azure"
        ? "Azure answers and Qwen judges receive separate prompts; gold data is judge-only."
        : "Answer and judge receive separate prompts; gold data is judge-only. Qwen and Moonshot use the same model for answering and judging.",
      "AMB category rubrics and answer prompts are pinned in the input bundle, including AMB date formatting and abstention handling; no exact parity with the original LongMemEval evaluation is claimed.",
      options.answerProvider === "azure"
        ? "The Qwen judge retains JSON instructions, reasoning none, a 4096-token output limit and a 600-second timeout. Azure answer retries and actual response model metadata are retained separately."
        : "Qwen defaults to JSON instructions, reasoning none, a 4096-token output limit and a 600-second timeout; explicit answer overrides are recorded separately. The initial resource trial used 180 seconds and remains separate. Gemini uses AMB model IDs and schema with no output-token override. Transient HTTP retries are recorded.",
      "Moonshot uses kimi-k2.7-code-highspeed, required enabled thinking, its default sampling temperature, JSON mode, an 8192-token output limit and a 180-second timeout. This differs from both Qwen and Hindsight's Gemini configuration.",
      "Model transport errors and malformed outputs count as incorrect in the fixed planned denominator. HTTP 429 and 5xx permit at most six attempts with exponential backoff starting at five seconds and capped at sixty seconds; longer server Retry-After cooldowns are respected. Dollar cost is unknown.",
    ],
    summary: summarize([], selected.length), results: [] as Row[],
  };
  writeFileSync(options.out, JSON.stringify(report), { flag: "wx" });
  writeFileSync(`${options.out}.jsonl`, "", { flag: "wx" });
  let next = 0;
  const byIndex: (Row | undefined)[] = new Array(selected.length);
  const started = Date.now();
  await Promise.all(Array.from({ length: Math.min(options.concurrency, selected.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= selected.length) return;
      const item = selected[index]!;
      const ranking = rankById.get(item.question_id);
      const row = await evaluateCase(item, options, ranking?.retrieved_session_ids, call, ranking?.retrieved_session_occurrences);
      byIndex[index] = row;
      appendFileSync(`${options.out}.jsonl`, `${JSON.stringify({ index, ...row })}\n`);
      const recorded = byIndex.filter((entry): entry is Row => entry !== undefined);
      const summary = summarize(recorded, selected.length);
      writeFileSync(`${options.out}.progress.json`, JSON.stringify({ status: "partial", elapsed_s: Math.round((Date.now() - started) / 1000), summary }));
      if (recorded.length % 10 === 0 || row.error) console.log(JSON.stringify({ recorded: recorded.length, planned: selected.length, correct: summary.correct, errors: summary.errors, elapsed_s: Math.round((Date.now() - started) / 1000) }));
    }
  }));
  report.results = byIndex.filter((entry): entry is Row => entry !== undefined);
  report.summary = summarize(report.results, selected.length);
  report.status = "complete"; report.finished_at = new Date().toISOString();
  writeFileSync(options.out, `${JSON.stringify(report)}\n`);
  writeFileSync(`${options.out}.progress.json`, JSON.stringify({ status: report.status, elapsed_s: Math.round((Date.now() - started) / 1000), summary: report.summary }));
  console.log(JSON.stringify(report.summary));
  return report;
}

export function parseArgs(args: string[]): Options {
  const options: Options = { input: "benchmark/data/longmemeval-amb-input-2026-10-19.json", out: "", retrieval: "lexical", concurrency: 3, contextChars: 180_000, topK: 10 };
  const keys: Record<string, string> = { "--input": "input", "--out": "out", "--provider": "provider", "--retrieval": "retrieval", "--rankings": "rankings", "--limit": "limit", "--concurrency": "concurrency", "--context-chars": "contextChars", "--top-k": "topK", "--evidence": "evidence", "--answer-provider": "answerProvider", "--request-mode": "requestMode", "--answer-check": "answerCheck", "--reasoning-effort": "reasoningEffort", "--max-output-tokens": "maxOutputTokens", "--evidence-policy": "evidencePolicy", "--evidence-ledger": "evidenceLedger", "--answer-policy": "answerPolicy", "--answer-recovery": "answerRecovery", "--answer-samples": "answerSamples", "--source-turns": "sourceTurns" };
  for (let i = 0; i < args.length; i++) {
    const key = keys[args[i]!], value = args[++i];
    if (!key || !value) throw new Error("Unknown or missing argument");
    Object.assign(options, { [key]: ["limit", "concurrency", "contextChars", "topK", "maxOutputTokens", "answerSamples"].includes(key) ? Number(value) : value });
  }
  if (!options.out) throw new Error("--out is required");
  if (!["lexical", "cached"].includes(options.retrieval)) throw new Error("Invalid retrieval mode");
  if (options.provider && !["gemini", "qwen-local", "moonshot"].includes(options.provider)) throw new Error("Invalid provider");
  if (options.evidence && !["prefix", "focused", "highlighted", "supplemental", "additive", "statements"].includes(options.evidence)) throw new Error("Invalid evidence mode");
  if (options.answerProvider && options.answerProvider !== "azure") throw new Error("Invalid answer provider");
  if (options.requestMode && !["standard", "robust"].includes(options.requestMode)) throw new Error("Invalid request mode");
  if (options.answerCheck && !["none", "grounded", "premise"].includes(options.answerCheck)) throw new Error("Invalid answer check");
  if (options.reasoningEffort && !["none", "low", "medium", "high", "adaptive"].includes(options.reasoningEffort)) throw new Error("Invalid reasoning effort");
  if (options.evidencePolicy && !["inline", "system"].includes(options.evidencePolicy)) throw new Error("Invalid evidence policy");
  if (options.evidenceLedger && !["none", "quoted", "units", "packed"].includes(options.evidenceLedger)) throw new Error("Invalid evidence ledger");
  if (options.answerPolicy && !["history", "minimal", "minimal-v2", "premise", "minimal-premise"].includes(options.answerPolicy)) throw new Error("Invalid answer policy");
  if (options.answerRecovery && !["none", "lower-effort", "lower-effort-transport", "longer-timeout-transport"].includes(options.answerRecovery)) throw new Error("Invalid answer recovery");
  if (options.answerSamples !== undefined && (!Number.isInteger(options.answerSamples) || options.answerSamples < 1 || options.answerSamples > 5)) throw new Error("Invalid answer samples");
  return options;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runEvaluation(parseArgs(process.argv.slice(2))).catch(() => { console.error("Evaluation failed; inspect the partial report and use a fresh output path."); process.exitCode = 1; });
}
