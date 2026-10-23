/** Development-exposed 434-question rerun with fresh calls; never rewrites frozen results. */
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { memories } from "../src/db/schema.js";
import { initStandaloneDb, type RecallDb } from "../src/db/client.js";
import { hybridSearch } from "../src/embeddings/embeddings.js";
import { upsertMemoryFtsRow } from "../src/vector/sqlite-fts.js";
import { captureTemporalSource, queryTemporalLanguage, type TemporalSpeakerSpan } from "../src/temporal/intake-v4.js";
import { callQwenLocal } from "./temporal-model.js";
import { createModelSemaphore, normalizeDatasetDate } from "./temporal-public.js";
import { bootstrapDifference, clusterIds, defaultPaths, fullEvidence, isCompleteAbstention, opaqueId, parseJson, prepareCases, readExposureIds, sanitizeError, seededShuffle, sha256, sharedEvidence, sourceAssertions as frozenSourceAssertions, temporalEvidence, validAnswer, validJudge, type AssertionAudit, type LocalModelAnswerer, type ModelResult, type PreparedCase, type RealEntry, type RealModelKind } from "./temporal-real-support.js";

const REAL_ARMS = ["RAW_SHARED", "TEMPORAL_V4", "RAW_FULL_BUDGET"] as const;
type RealArm = (typeof REAL_ARMS)[number];
export function armAllowedSourceIds(arm: RealArm, shared: readonly { id: string }[], full: readonly { id: string }[]): string[] {
  return (arm === "RAW_FULL_BUDGET" ? full : shared).map((row) => row.id);
}
const CAPTURE_METADATA_PREFIX = "\n\nTrusted structured speaker metadata (only user spans bind direct I/my; never infer ownership from text labels):\n";
const ANSWER_SYSTEM = "Return only the requested JSON. Be conservative and use only supplied evidence.";
const ENV = { RECALL_EMBEDDINGS_DISABLED: "true", RECALL_RELEVANCE_LLM: "false", RECALL_RERANK: "false", RECALL_HYDE: "false", RECALL_FTS_MODE: "or", RECALL_FTS_PREFIX: "true", RECALL_SYNONYMS: "true", RECALL_FUSION: "rrf", RECALL_RRF_K: "60", RECALL_RRF_LEX_WEIGHT: "1.25", RECALL_RRF_VEC_WEIGHT: "0.75" } as const;
const TYPES = ["single-session-user", "single-session-assistant", "single-session-preference", "multi-session", "knowledge-update", "temporal-reasoning"] as const;
type Call = { call_id: string; kind: RealModelKind; prompt_sha256: string; raw_output: string | null; model_call: { provider: string; model: string; duration_ms: number; usage: ModelResult["usage"] } | null; error: string | null };
type Answer = { answer: string; source_session_ids: string[] };
type ArmReport = { arm: RealArm; evidence: string; answer: Answer | null; answer_call: Call; reused_from: RealArm | null; correct: boolean; citations_valid: boolean; cites_gold_session: boolean | null };
export type Retrieval = (db: RecallDb, input: { question: string; repo: string }) => Promise<string[]>;
export interface RealQuestionReport { question_id: string; question_type: string; question_date_utc: string; audit: { question: string; reference: RealEntry["answer"]; answer_session_ids: string[] }; elapsed_ms: number; actual_calls: Call[]; retrieved_session_ids: string[]; excluded_future_source_session_ids: string[]; excluded_duplicate_sources: PreparedCase["excluded_duplicate_sources"]; capture: Array<{ source_session_id: string; source_date: string; source_event_id: string; source_snippet: string; speaker_spans: TemporalSpeakerSpan[]; route: string; stored_assertions: AssertionAudit[]; rejected: unknown; error: string | null; raw_output: string | null; call: Call | null }>; query: { route: string; error: string | null; raw_output: string | null; facts: AssertionAudit[]; as_of: string | null; observed_before: string | null; conflict: boolean; truncated: boolean; call: Call | null } | null; temporal_reason: string | null; arms: ArmReport[]; judge: Call | null; judge_expected_ids: string[] | null; error: string | null; }
export interface RealReport { status: "prepared" | "partial" | "complete"; started_at_utc: string; elapsed_ms: number; invocation: { provider: "qwen-local" | null; planned: number; limit: number | null; model: string; reasoning: "none"; temperature: 0; max_output_tokens: 512; model_concurrency: 6; world_concurrency: 6; env: typeof ENV }; manifest: { evaluation_mode: "development-exposed-rerun"; original_report_sha256: string; dataset_sha256: string; exposure_sha256: Record<string, string>; harness_sha256: string; support_sha256: string; protocol_sha256: string; dependency_sha256: Record<string, string>; prompt_sha256: Record<string, string>; planned_question_ids: string[]; planned_cases: Array<{ id: string; category: string; abstention: boolean; future_source_ids: string[]; duplicate_sources: PreparedCase["excluded_duplicate_sources"] }>; planned_categories: Record<string, number>; excluded_question_ids: string[] }; limitations: string[]; questions: RealQuestionReport[]; summary: Record<string, unknown>; }

function originalReportPath() { return fileURLToPath(new URL("./data/temporal-real-holdout-real-2026-10-18.json", import.meta.url)); }
/** Selection reads prior IDs only, never prior extraction, answers or grades. */
export function prepareRepeatedCases(dataset: readonly RealEntry[], path: string, limit?: number): ReturnType<typeof prepareCases> {
  const prior = JSON.parse(readFileSync(path, "utf8")) as { manifest?: { planned_question_ids?: unknown } };
  const ids = prior.manifest?.planned_question_ids;
  if (!Array.isArray(ids) || ids.length !== 434 || ids.some((id) => typeof id !== "string") || new Set(ids).size !== 434) throw new Error("original report must declare exactly 434 unique planned IDs");
  const validated = prepareCases(dataset, new Set());
  const byId = new Map(validated.cases.map((item) => [item.entry.question_id, item]));
  if (ids.some((id) => !byId.has(id))) throw new Error("original planned ID missing from dataset");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) throw new Error("invalid preparation limit");
  const cases = ids.map((id) => byId.get(id)!);
  const abstentions = cases.filter((item) => item.entry.question_id.endsWith("_abs")).length;
  if (abstentions !== 24 || TYPES.some((type) => !cases.some((item) => item.entry.question_type === type && !item.entry.question_id.endsWith("_abs")))) throw new Error("original selection must include six answerable categories and 24 abstentions");
  return { cases: limit === undefined ? cases : cases.slice(0, limit), excluded_question_ids: dataset.filter((entry) => !ids.includes(entry.question_id)).map((entry) => entry.question_id) };
}
/** Content offsets come from structured turns and are clipped to the selected prefix. */
export function trustedSpeakerSpans(entry: RealEntry, sessionId: string, snippet: string): TemporalSpeakerSpan[] {
  const indices = entry.haystack_session_ids.flatMap((id, index) => id === sessionId ? [index] : []);
  if (indices.length !== 1) throw new Error("speaker metadata source must be unique");
  const turns = entry.haystack_sessions[indices[0]!]!;
  const raw = turns.map((turn) => `${turn.role}: ${turn.content}`).join("\n");
  if (raw.slice(0, snippet.length) !== snippet) throw new Error("selected snippet does not match structured source prefix");
  let offset = 0;
  const spans: TemporalSpeakerSpan[] = [];
  for (const turn of turns) {
    const start = offset + turn.role.length + 2, end = Math.min(start + turn.content.length, snippet.length);
    if (start < end && (turn.role === "user" || turn.role === "assistant")) spans.push({ start, end, role: turn.role, subject: turn.role });
    offset = start + turn.content.length + 1;
  }
  // Do not silently remove trusted metadata if the adapter's bounded contract overflows.
  return spans;
}
/** Stored receipts preserve metadata; answer evidence uses their original source text. */
function sourceAssertions(facts: Parameters<typeof frozenSourceAssertions>[0], events: ReadonlyMap<string, string>) {
  return frozenSourceAssertions(facts.map((fact) => {
    let evidence = fact.evidence;
    try { const receipt = JSON.parse(evidence) as { version?: unknown; text?: unknown; speaker_spans?: unknown }; if ((receipt.version === 3 || receipt.version === 4) && typeof receipt.text === "string" && Array.isArray(receipt.speaker_spans)) evidence = receipt.text; } catch { /* Plain evidence stays unchanged. */ }
    return { ...fact, evidence };
  }), events);
}

function answerPrompt(question: string, date: string, evidence: string) { return `Answer using only supplied evidence. Return JSON {"answer":string,"source_session_ids":string[]}. Cite only source_session_ids printed in evidence. If unsupported, answer exactly "unknown" with [].\nquestion_date_utc: ${date}\nquestion: ${question}\nevidence:\n${evidence}`; }
function judgePrompt(entry: RealEntry, candidates: Array<{ id: string; answer: string }>) { return `Judge semantic equivalence. Return JSON {"scores":[{"id":string,"correct":boolean}]}, exactly once for every candidate id and no other ids. Check required entities, dates, numbers, and answer parts; ignore casing/presentation unless meaning changes. Preference references are rubrics: a different recommendation can be correct if it incorporates the stated preferences.\nquestion_type: ${entry.question_type}\nquestion_date_utc: ${normalizeDatasetDate(entry.question_date)}\nquestion: ${entry.question}\nreference: ${entry.answer}\ncandidates:\n${candidates.map((candidate) => `${candidate.id}: ${candidate.answer}`).join("\n")}`; }
function emptyCall(kind: RealModelKind): Call { return { call_id: `not_called:${kind}`, kind, prompt_sha256: sha256("not_called"), raw_output: null, model_call: null, error: null }; }
function callRecord(id: string, kind: RealModelKind, system: string, user: string, result: ModelResult | null, error: unknown): Call { return { call_id: id, kind, prompt_sha256: sha256(`${system}\n${user}`), raw_output: result?.text ?? null, model_call: result ? { provider: result.provider, model: result.model, duration_ms: result.duration_ms, usage: result.usage } : null, error: error ? sanitizeError(error) : null }; }
async function request(id: string, kind: RealModelKind, system: string, user: string, answerer: LocalModelAnswerer | undefined, semaphore: ReturnType<typeof createModelSemaphore>): Promise<Call> {
  try { const result = await semaphore(() => answerer ? answerer({ kind, system, user }) : callQwenLocal({ system, user, reasoning_effort: "none" })); return callRecord(id, kind, system, user, result, null); }
  catch (error) { return callRecord(id, kind, system, user, null, error); }
}
function insertRows(db: RecallDb, rows: readonly { id: string; text: string }[], repo: string): Map<string, string> {
  const map = new Map<string, string>(), now = "2026-10-18T00:00:00.000Z";
  for (const row of rows) { const id = `real-${sha256(`${repo}\0${row.id}`).slice(0, 28)}`; db.insert(memories).values({ id, type: "rule", text: row.text, scope: "repo", path_scope: null, repo, status: "active", confidence: .9, source: "repo_scan", evidence: [], capture_context: null, note: null, supersedes: null, dedupe_key: null, created_at: now, updated_at: now, last_validated_at: null, last_injected_at: null, injection_count: 0, override_count: 0, repetition_count: 0 }).run(); upsertMemoryFtsRow(db, { id, text: row.text, note: null, repo, status: "active", type: "rule", scope: "repo", path_scope: null, confidence: .9 }); map.set(id, row.id); }
  return map;
}
/** Production default: frozen hybridSearch, with embeddings explicitly null. */
export const productionRetrieval: Retrieval = async (db, input) => (await hybridSearch(db, input.question, null, { repo: input.repo, limit: 10 })).map((hit) => hit.memory.id);

async function runCase(item: PreparedCase, options: { answerer?: LocalModelAnswerer; retrieval?: Retrieval; semaphore: ReturnType<typeof createModelSemaphore> }): Promise<RealQuestionReport> {
  const started = Date.now();
  const date = normalizeDatasetDate(item.entry.question_date)!;
  const report: RealQuestionReport = { question_id: item.entry.question_id, question_type: item.entry.question_type, question_date_utc: date, audit: { question: item.entry.question, reference: item.entry.answer, answer_session_ids: item.entry.answer_session_ids }, elapsed_ms: 0, actual_calls: [], retrieved_session_ids: [], excluded_future_source_session_ids: item.future_source_ids, excluded_duplicate_sources: item.excluded_duplicate_sources, capture: [], query: null, temporal_reason: null, arms: [], judge: null, judge_expected_ids: null, error: null };
  const invoke = async (id: string, kind: RealModelKind, system: string, user: string) => { const call = await request(id, kind, system, user, options.answerer, options.semaphore); report.actual_calls.push(call); return call; };
  let db: RecallDb | undefined;
  try {
    const repo = `temporal-real/${sha256(item.entry.question_id).slice(0, 24)}`, root = mkdtempSync(join(tmpdir(), "recall-temporal-real-"));
    db = initStandaloneDb(join(root, "case.db"));
    const memoryMap = insertRows(db, item.source_rows, repo);
    const retrieved = await (options.retrieval ?? productionRetrieval)(db, { question: item.entry.question, repo });
    const sourceById = new Map(item.source_rows.map((row) => [row.id, row]));
    const rows = retrieved.map((memoryId) => memoryMap.get(memoryId) ?? memoryId).filter((id): id is string => sourceById.has(id)).map((id) => sourceById.get(id)!);
    report.retrieved_session_ids = rows.map((row) => row.id);
    const shared = sharedEvidence(rows), full = fullEvidence(rows);
    const eventToSession = new Map<string, string>();
    for (const [index, row] of [...shared.snippets].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)).entries()) {
      const eventId = `e${index}`, speaker_spans = trustedSpeakerSpans(item.entry, row.id, row.text); eventToSession.set(eventId, row.id); let call: Call | null = null;
      const result = await captureTemporalSource(db, { repo, event_id: eventId, observed_at: row.date, text: row.text, speaker_spans }, { model: async (input) => { call = await invoke(`${item.entry.question_id}:capture:${eventId}`, "capture", input.system, `${input.user}${CAPTURE_METADATA_PREFIX}${JSON.stringify(speaker_spans)}`); if (call.error) throw new Error(call.error); return call.raw_output!; } });
      const stored = sourceAssertions(result.stored, eventToSession)?.facts ?? [];
      report.capture.push({ source_session_id: row.id, source_date: row.date, source_event_id: eventId, source_snippet: row.text, speaker_spans, route: result.route, stored_assertions: stored, rejected: result.rejected, error: result.error, raw_output: result.raw_output, call });
    }
    let queryCall: Call | null = null;
    const queryResult = await queryTemporalLanguage(db, { repo, text: item.entry.question, now: date }, { model: async (input) => { queryCall = await invoke(`${item.entry.question_id}:query`, "query", input.system, input.user); if (queryCall.error) throw new Error(queryCall.error); return queryCall.raw_output!; } });
    const mapped = queryResult.result ? sourceAssertions(queryResult.result.facts, eventToSession) : null;
    report.query = { route: queryResult.route, error: queryResult.error, raw_output: queryResult.raw_output, facts: mapped?.facts ?? [], as_of: queryResult.result?.as_of ?? null, observed_before: queryResult.result?.observed_before ?? null, conflict: queryResult.result?.conflict ?? false, truncated: queryResult.result?.truncated ?? false, call: queryCall };
    let temporal = shared.text;
    if (queryResult.route !== "temporal") report.temporal_reason = queryResult.error ?? "query_fallback";
    else if (!queryResult.result?.facts.length) report.temporal_reason = "empty_temporal_result";
    else if (queryResult.result.truncated) report.temporal_reason = "temporal_truncated";
    else if (!mapped) report.temporal_reason = "unmapped_temporal_source";
    else { const assertions = queryResult.result.conflict ? `conflict:true\nalternatives:\n${mapped.text}` : mapped.text; const augmented = temporalEvidence(shared.text, assertions); if (augmented) { temporal = augmented; report.temporal_reason = "temporal"; } else report.temporal_reason = "augmentation_over_budget"; }
    const evidence: Record<RealArm, string> = { RAW_SHARED: shared.text, TEMPORAL_V4: temporal, RAW_FULL_BUDGET: full.text };
    const answerByEvidence = new Map<string, { answer: Answer | null; call: Call; arm: RealArm }>();
    for (const arm of REAL_ARMS) {
      const previous = answerByEvidence.get(evidence[arm]);
      const call = previous?.call ?? await invoke(`${item.entry.question_id}:answer:${arm}`, "answer", ANSWER_SYSTEM, answerPrompt(item.entry.question, date, evidence[arm]));
      const answer = previous?.answer ?? validAnswer(parseJson(call.raw_output), armAllowedSourceIds(arm, shared.snippets, full.snippets));
      answerByEvidence.set(evidence[arm], { answer, call, arm });
      report.arms.push({ arm, evidence: evidence[arm], answer, answer_call: call, reused_from: previous?.arm ?? null, correct: false, citations_valid: answer !== null, cites_gold_session: null });
    }
    const unique = new Map<string, { answer: Answer; call: Call }>();
    for (const arm of report.arms) if (arm.answer && !unique.has(arm.answer.answer)) unique.set(arm.answer.answer, { answer: arm.answer, call: arm.answer_call });
    if (item.entry.question_id.endsWith("_abs")) for (const arm of report.arms) arm.correct = Boolean(arm.answer && isCompleteAbstention(arm.answer.answer));
    else if (unique.size) {
      const seed = Number.parseInt(sha256(item.entry.question_id).slice(0, 8), 16);
      const candidates = seededShuffle([...unique.values()], seed).map((candidate, index) => ({ id: opaqueId(index), ...candidate }));
      const byAnswer = new Map(candidates.map((candidate) => [candidate.answer.answer, candidate.id]));
      report.judge_expected_ids = candidates.map((candidate) => candidate.id);
      report.judge = await invoke(`${item.entry.question_id}:judge`, "judge", ANSWER_SYSTEM, judgePrompt(item.entry, candidates.map(({ id, answer }) => ({ id, answer: answer.answer }))));
      const verdicts = validJudge(parseJson(report.judge.raw_output), report.judge_expected_ids);
      if (verdicts) for (const arm of report.arms) arm.correct = Boolean(arm.answer && verdicts.get(byAnswer.get(arm.answer.answer)!));
    }
    for (const arm of report.arms) arm.cites_gold_session = item.entry.question_id.endsWith("_abs") ? null : Boolean(arm.answer?.source_session_ids.some((id) => item.entry.answer_session_ids.includes(id)));
  } catch (error) { report.error = sanitizeError(error); }
  finally { try { db?.$client.close(); } catch { report.error ??= "database_close_failed"; } report.elapsed_ms = Date.now() - started; }
  return report;
}

function calls(report: RealReport): Call[] { return [...new Map(report.questions.flatMap((question) => question.actual_calls).map((call) => [call.call_id, call])).values()]; }
function count(planned: readonly PreparedCase[], found: ReadonlyMap<string, RealQuestionReport>, arm: RealArm, predicate: (item: PreparedCase) => boolean) { const items = planned.filter(predicate), reports = items.map((item) => found.get(item.entry.question_id)), rows = reports.map((report) => report?.arms.find((candidate) => candidate.arm === arm)), correct = rows.filter((row) => row?.correct).length; return { planned: items.length, completed: reports.filter(Boolean).length, correct, score: items.length ? correct / items.length : null, citations_valid: rows.filter((row) => row?.citations_valid).length, gold_session_hits: rows.filter((row) => row?.cites_gold_session).length }; }
function summarize(report: RealReport, planned: readonly PreparedCase[], final: boolean) {
  const found = new Map(report.questions.map((question) => [question.question_id, question])), actualCalls = calls(report);
  const perCategory = Object.fromEntries([...new Set([...TYPES, ...planned.map((item) => item.entry.question_type)])].map((category) => [category, { planned: planned.filter((item) => item.entry.question_type === category && !item.entry.question_id.endsWith("_abs")).length, arms: Object.fromEntries(REAL_ARMS.map((arm) => [arm, count(planned, found, arm, (item) => item.entry.question_type === category && !item.entry.question_id.endsWith("_abs"))])) }]));
  const abstention = { planned: planned.filter((item) => item.entry.question_id.endsWith("_abs")).length, arms: Object.fromEntries(REAL_ARMS.map((arm) => [arm, count(planned, found, arm, (item) => item.entry.question_id.endsWith("_abs"))])) };
  const arms = Object.fromEntries(REAL_ARMS.map((arm) => [arm, count(planned, found, arm, () => true)]));
  const routeCounts: Record<string, number> = {}, reasonCounts: Record<string, number> = {}, captureErrors: Record<string, number> = {}, rejections: Record<string, number> = {};
  const errors: Record<string, number> = { world: report.questions.filter((question) => question.error !== null).length, capture_schema: 0, query_schema: 0, answer_schema: 0, judge_schema: 0 };
  const schemaCalls = new Set<string>();
  const schemaFailure = (call: Call | null, stage: string) => { if (call && !schemaCalls.has(call.call_id)) { schemaCalls.add(call.call_id); errors[stage] = (errors[stage] ?? 0) + 1; } };
  for (const question of report.questions) {
    if (question.temporal_reason && question.temporal_reason !== "temporal") reasonCounts[question.temporal_reason] = (reasonCounts[question.temporal_reason] ?? 0) + 1;
    for (const capture of question.capture) {
      routeCounts[capture.route] = (routeCounts[capture.route] ?? 0) + 1;
      if (capture.error) captureErrors[capture.error] = (captureErrors[capture.error] ?? 0) + 1;
      if (capture.error === "model_response_invalid" || capture.error === "invalid_fact_count") schemaFailure(capture.call, "capture_schema");
      if (Array.isArray(capture.rejected)) for (const rejection of capture.rejected) {
        const reason = typeof rejection?.reason === "string" ? rejection.reason : "unknown";
        rejections[reason] = (rejections[reason] ?? 0) + 1;
      }
    }
    if (question.query?.error === "model_response_invalid") schemaFailure(question.query.call, "query_schema");
    for (const arm of question.arms) if (!arm.answer && arm.answer_call.raw_output !== null) schemaFailure(arm.answer_call, "answer_schema");
    if (question.judge && question.judge.raw_output !== null && !validJudge(parseJson(question.judge.raw_output), question.judge_expected_ids ?? [])) schemaFailure(question.judge, "judge_schema");
  }
  for (const call of actualCalls) if (call.error) errors[call.kind] = (errors[call.kind] ?? 0) + 1;
  const usage = (field: keyof ModelResult["usage"], selected = actualCalls) => {
    const observed = selected.reduce((sum, call) => sum + (call.model_call?.usage[field] ?? 0), 0);
    const unknown = selected.filter((call) => call.model_call?.usage[field] == null).length;
    return { observed_total: observed, unknown_count: unknown, total: unknown ? null : observed };
  };
  const failureCases = report.questions.filter((question) => question.error || question.actual_calls.some((call) => call.error || schemaCalls.has(call.call_id))).length;
  const failedCalls = actualCalls.filter((call) => call.error || schemaCalls.has(call.call_id)).length;
  const latencyByStage = Object.fromEntries((["capture", "query", "answer", "judge"] as const).map((kind) => {
    const selected = actualCalls.filter((call) => call.kind === kind);
    const times = selected.flatMap((call) => call.model_call ? [call.model_call.duration_ms] : []).sort((a, b) => a - b);
    return [kind, { calls: selected.length, duration_observations: times.length, total_model_ms: times.reduce((a, b) => a + b, 0), p50_model_ms: times.length ? times[Math.floor(times.length / 2)] : null, p95_model_ms: times.length ? times[Math.min(times.length - 1, Math.floor(times.length * .95))] : null, tokens: usage("total_tokens", selected) }];
  }));
  const clusters = clusterIds(planned.map((item) => item.entry));
  const paired = (control: RealArm) => { const rows = planned.map((item) => { const question = found.get(item.entry.question_id), temporal = question?.arms.find((arm) => arm.arm === "TEMPORAL_V4")?.correct ?? false, raw = question?.arms.find((arm) => arm.arm === control)?.correct ?? false; return { id: item.entry.question_id, cluster: clusters.get(item.entry.question_id)!, candidate: temporal, control: raw }; }); return { wins: rows.filter((row) => row.candidate && !row.control).length, losses: rows.filter((row) => !row.candidate && row.control).length, ties: rows.filter((row) => row.candidate === row.control).length, bootstrap: final ? bootstrapDifference(rows) : { pending: true, clusters: new Set(rows.map((row) => row.cluster)).size, seed: 20261018 } }; };
  const full = paired("RAW_FULL_BUDGET"), shared = paired("RAW_SHARED"), ordinary = ["single-session-user", "single-session-assistant", "single-session-preference"].map((type) => ({ type, difference_pp: 100 * ((perCategory[type]?.arms.TEMPORAL_V4.score ?? 0) - (perCategory[type]?.arms.RAW_FULL_BUDGET.score ?? 0)) }));
  const failureRate = report.questions.length ? failureCases / report.questions.length : null;
  const fullBootstrap = final ? full.bootstrap as ReturnType<typeof bootstrapDifference> : null;
  const gain = typeof fullBootstrap?.difference_pp === "number" && fullBootstrap.difference_pp >= 5 && (fullBootstrap.lower95_pp ?? -Infinity) > 0;
  const ordinaryPassed = ordinary.every((row) => row.difference_pp >= -5 - 1e-9);
  const errorsPassed = failureRate !== null && failureRate <= .05;
  return { planned: planned.length, completed: report.questions.length, elapsed_ms: report.elapsed_ms, per_category: perCategory, abstention, arms, temporal: { actual_used: report.questions.filter((question) => question.temporal_reason === "temporal").length, fallback_reasons: reasonCounts, capture_routes: routeCounts, capture_errors: captureErrors, rejected_proposals: rejections, stored_assertions: report.questions.reduce((sum, question) => sum + question.capture.reduce((n, source) => n + source.stored_assertions.length, 0), 0) }, errors_by_stage: errors, failure_rates: { cases_with_request_schema_or_world_failure: failureCases, completed_case_denominator: report.questions.length, case_rate: failureRate, unique_failed_calls: failedCalls, actual_call_denominator: actualCalls.length, call_rate: actualCalls.length ? failedCalls / actualCalls.length : null }, usage: { unique_calls: actualCalls.length, prompt_tokens: usage("prompt_tokens"), completion_tokens: usage("completion_tokens"), total_tokens: usage("total_tokens"), cost_usd: null, stages: latencyByStage }, paired: { temporal_vs_raw_shared: shared, temporal_vs_raw_full: full }, integration_diagnostic: { gain_hurdle: gain, ordinary_hurdle: ordinaryPassed, ordinary_regressions_pp: ordinary, errors_at_most_5_percent: errorsPassed, accuracy_hurdles_met: report.status === "complete" && gain && ordinaryPassed && errorsPassed, broader_integration_ready: false, remaining_checks: ["representative deployed retrieval", "independently checked capture quality", "privacy, retention, removal and export", "Cloud round trips"] } };
}
function writeAtomic(path: string, report: RealReport) { const temp = `${path}.tmp`; writeFileSync(temp, JSON.stringify(report, null, 2)); renameSync(temp, path); }
function hashFile(path: string) { return existsSync(path) ? sha256(readFileSync(path)) : "missing"; }
function newReport(options: NonNullable<Parameters<typeof runTemporalRealEvaluation>[0]>, prepared: ReturnType<typeof prepareCases>, datasetPath: string, exposurePaths: string[]): RealReport {
  const source = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
  const tree = (relative: string): string[] => readdirSync(source(relative), { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? tree(`${relative}/${entry.name}`) : [`${relative}/${entry.name}`]);
  const dependencies = ["./temporal-public.ts", "./temporal-model.ts", "../package.json", "../package-lock.json", ...tree("../src"), ...tree("../drizzle")].sort();
  const categories = Object.fromEntries(prepared.cases.reduce((map, item) => map.set(item.entry.question_type, (map.get(item.entry.question_type) ?? 0) + 1), new Map<string, number>()));
  return { status: options.provider ? "partial" : "prepared", started_at_utc: new Date().toISOString(), elapsed_ms: 0, invocation: { provider: options.provider ?? null, planned: prepared.cases.length, limit: options.limit ?? null, model: "qwen3.8-flash-next", reasoning: "none", temperature: 0, max_output_tokens: 512, model_concurrency: 6, world_concurrency: 6, env: ENV }, manifest: { evaluation_mode: "development-exposed-rerun", original_report_sha256: hashFile(options.originalReportPath ?? originalReportPath()), dataset_sha256: options.dataset ? sha256(JSON.stringify(options.dataset)) : hashFile(datasetPath), exposure_sha256: Object.fromEntries(exposurePaths.map((path) => [path, hashFile(path)])), harness_sha256: hashFile(fileURLToPath(import.meta.url)), support_sha256: hashFile(source("./temporal-real-support.ts")), protocol_sha256: hashFile(source("./TEMPORAL-V4-REAL-PROTOCOL.md")), dependency_sha256: Object.fromEntries(dependencies.map((path) => [path, hashFile(source(path))])), prompt_sha256: { capture_metadata_prefix: sha256(CAPTURE_METADATA_PREFIX), answer_system: sha256(ANSWER_SYSTEM), answer_template: sha256(answerPrompt("{question}", "{date}", "{evidence}")), judge_template: sha256(judgePrompt({ question_id: "{id}", question_type: "{type}", question: "{question}", question_date: "2026/01/01 (Thu) 00:00", answer: "{reference}", answer_session_ids: [], haystack_session_ids: [], haystack_dates: [], haystack_sessions: [] }, [{ id: "a0", answer: "{answer}" }])) }, planned_question_ids: prepared.cases.map((item) => item.entry.question_id), planned_cases: prepared.cases.map((item) => ({ id: item.entry.question_id, category: item.entry.question_type, abstention: item.entry.question_id.endsWith("_abs"), future_source_ids: item.future_source_ids, duplicate_sources: item.excluded_duplicate_sources })), planned_categories: categories, excluded_question_ids: prepared.excluded_question_ids }, limitations: ["Repeated development-exposed public questions: exactly the original 434 IDs. These are not an independent holdout or official benchmark.", "Every capture, query, answer and judge executed in this run is fresh; only identical answer evidence within one case may share a new answer call. Resume preserves only this run's immutable completed checkpoints.", "The frozen historical v2/v3 scores are contextual only; this run compares v4 with two fresh raw controls and does not isolate v4 against a fresh v3 arm.", "Trusted speaker spans derive only from dataset structured role fields and content offsets; labels inside source text never establish identity. No declared predicate policies or synthetic vocabulary are supplied.", "Fresh lexical Recall retrieval with embeddings disabled; this does not measure the deployed vector, lifecycle, promotion, or Cloud stack.", "Capture is retrieval-time and question-conditioned through selected snippets; the frozen adapter receives no question during capture.", "The same model semantically judges answers and can err. Citation syntax/subset validity and gold-session hits do not establish source entailment.", "Session text is truncated from the start; a retrieved gold session does not guarantee its answer turn is visible.", "Dollar cost is unknown; character caps are not exact token caps."], questions: [], summary: {} };
}
function compatible(existing: RealReport, report: RealReport) { return JSON.stringify(existing.manifest) === JSON.stringify(report.manifest) && JSON.stringify(existing.invocation) === JSON.stringify(report.invocation); }
export async function runTemporalRealEvaluation(options: { provider?: "qwen-local"; answerer?: LocalModelAnswerer; dataset?: RealEntry[]; exposurePaths?: string[]; retrieval?: Retrieval; limit?: number; out?: string; resume?: boolean; synthetic?: boolean; rerunExposedIds?: boolean; originalReportPath?: string } = {}): Promise<RealReport> {
  if (options.provider && options.provider !== "qwen-local") throw new Error("unsupported provider");
  if (options.provider && options.limit !== undefined && !options.synthetic) throw new Error("--limit is preparation/synthetic-only; formal provider runs select all cases");
  if (options.out && existsSync(options.out) && !options.resume) throw new Error("refusing to overwrite existing output; use --resume for a compatible checkpoint");
  const paths = defaultPaths(), datasetPath = paths.dataset, exposurePaths = options.exposurePaths ?? paths.exposure, dataset = options.dataset ?? JSON.parse(readFileSync(datasetPath, "utf8")) as RealEntry[];
  if (!options.synthetic && !options.rerunExposedIds) throw new Error("explicit --rerun-exposed-ids is required for repeated public questions");
  const prepared = options.synthetic ? prepareCases(dataset, readExposureIds(exposurePaths), options.limit) : prepareRepeatedCases(dataset, options.originalReportPath ?? originalReportPath(), options.limit);
  const report = newReport(options, prepared, datasetPath, exposurePaths);
  if (options.resume && !options.out) throw new Error("--resume requires --out");
  if (options.resume && options.out) { const prior = JSON.parse(readFileSync(options.out, "utf8")) as RealReport; if (!compatible(prior, report)) throw new Error("resume checkpoint manifest does not match frozen inputs"); if (new Set(prior.questions.map((question) => question.question_id)).size !== prior.questions.length || prior.questions.some((question) => !report.manifest.planned_question_ids.includes(question.question_id))) throw new Error("invalid checkpoint case IDs"); report.questions = prior.questions; report.started_at_utc = prior.started_at_utc; }
  if (!options.provider || prepared.cases.length === 0) { report.status = "prepared"; report.summary = summarize(report, prepared.cases, false); if (options.out) writeAtomic(options.out, report); return report; }
  const inherited = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]])) as Record<keyof typeof ENV, string | undefined>; Object.assign(process.env, ENV);
  const semaphore = createModelSemaphore(6), done = new Map(report.questions.map((question) => [question.question_id, question])), pending = prepared.cases.filter((item) => !done.has(item.entry.question_id));
  let cursor = 0;
  const worker = async () => { while (true) { const index = cursor++; if (index >= pending.length) return; const item = pending[index]!; const result = await runCase(item, { answerer: options.answerer, retrieval: options.retrieval, semaphore }); done.set(result.question_id, result); report.questions = prepared.cases.map((caseItem) => done.get(caseItem.entry.question_id)).filter((value): value is RealQuestionReport => value !== undefined); report.elapsed_ms = Date.now() - Date.parse(report.started_at_utc); report.summary = summarize(report, prepared.cases, false); if (options.out) writeAtomic(options.out, report); if (report.questions.length % 10 === 0) process.stdout.write(`temporal-real-v4: ${report.questions.length}/${prepared.cases.length}\n`); } };
  try { const outcomes = await Promise.allSettled(Array.from({ length: Math.min(6, pending.length) }, worker)); const failed = outcomes.find((outcome) => outcome.status === "rejected"); if (failed?.status === "rejected") throw failed.reason; report.status = report.questions.length === prepared.cases.length ? "complete" : "partial"; return report; }
  finally { for (const key of Object.keys(ENV) as Array<keyof typeof ENV>) if (inherited[key] === undefined) delete process.env[key]; else process.env[key] = inherited[key]; report.elapsed_ms = Date.now() - Date.parse(report.started_at_utc); report.summary = summarize(report, prepared.cases, report.status === "complete"); if (options.out) writeAtomic(options.out, report); }
}
function parseArgs(argv: string[]) { const args: { provider?: "qwen-local"; out?: string; prepare?: boolean; limit?: number; resume?: boolean; rerunExposedIds?: boolean; originalReportPath?: string } = {}; for (let i = 2; i < argv.length; i++) { const value = argv[i]; if (value === "--provider") args.provider = argv[++i] as "qwen-local"; else if (value === "--out") args.out = argv[++i]; else if (value === "--prepare") args.prepare = true; else if (value === "--limit") args.limit = Number(argv[++i]); else if (value === "--resume") args.resume = true; else if (value === "--rerun-exposed-ids") args.rerunExposedIds = true; else if (value === "--original-report") args.originalReportPath = argv[++i]; else throw new Error(`unknown argument: ${value}`); } return args; }
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) { const args = parseArgs(process.argv); if (args.provider && args.provider !== "qwen-local") throw new Error("--provider must be qwen-local"); runTemporalRealEvaluation({ provider: args.prepare ? undefined : args.provider, out: args.out, limit: args.limit, resume: args.resume, rerunExposedIds: args.rerunExposedIds, originalReportPath: args.originalReportPath }).then((report) => process.stdout.write(`${report.status}: ${report.invocation.planned} planned\n`)); }
