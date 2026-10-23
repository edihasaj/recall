/** Offline helpers for the held-out public-conversation temporal evaluation. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { baselineEvidence, normalizeDatasetDate, seededShuffle, type PublicEntry } from "./temporal-public.js";

export const REAL_ARMS = ["RAW_SHARED", "TEMPORAL_V2", "RAW_FULL_BUDGET"] as const;
export type RealArm = (typeof REAL_ARMS)[number];
export type RealEntry = Omit<PublicEntry, "answer"> & { answer: string | number };
export type SourceRow = { id: string; date: string; text: string };
export type PreparedCase = { entry: RealEntry; excluded_duplicate_sources: Array<{ id: string; dates: string[] }>; source_rows: SourceRow[]; future_source_ids: string[] };
export type ModelUsage = { prompt_tokens: number | null; completion_tokens: number | null; total_tokens: number | null; cost_usd: null };
export type ModelResult = { text: string; provider: "qwen-local"; model: string; duration_ms: number; usage: ModelUsage };
export type RealModelKind = "capture" | "query" | "answer" | "judge";
export type LocalModelAnswerer = (input: { kind: RealModelKind; system: string; user: string }) => Promise<ModelResult>;
export type AssertionAudit = { id?: string; event_id?: string; supersedes_id?: string | null; subject: string; predicate: string; value: string; valid_from: string; valid_to: string | null; observed_at: string; source_event_id: string; source_session_id: string; evidence: string; evidence_excerpt: string };

export function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
export function parseJson(value: string | null): unknown | null { try { return value ? JSON.parse(value.replace(/^```(?:json)?\s*|\s*```$/g, "")) : null; } catch { return null; } }
export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function sanitizeError(error: unknown): string { const message = error instanceof Error ? error.message : "request_failed"; return /HTTP \d{3}/.test(message) ? message.match(/HTTP \d{3}/)![0] : /timeout/i.test(message) ? "timeout" : "request_failed"; }
export function opaqueId(index: number): string { return `a${index}`; }
export function rawSession(turns: RealEntry["haystack_sessions"][number]): string { return turns.map((turn) => `${turn.role}: ${turn.content}`).join("\n"); }

function reportIds(value: unknown): string[] {
  if (!isRecord(value)) throw new Error("invalid exposure report");
  for (const group of [value.results, value.questions]) if (group !== undefined) {
    if (!Array.isArray(group)) throw new Error("invalid exposure report questions");
    return group.map((row) => { if (!isRecord(row) || typeof row.question_id !== "string" || !row.question_id) throw new Error("invalid exposure question_id"); return row.question_id; });
  }
  throw new Error("exposure report has no results or questions");
}
export function readExposureIds(paths: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const path of paths) {
    if (!existsSync(path)) throw new Error(`exposure file not found: ${path}`);
    for (const id of reportIds(JSON.parse(readFileSync(path, "utf8")))) ids.add(id);
  }
  return ids;
}
function assertEntry(entry: RealEntry): void {
  if (!entry || typeof entry.question_id !== "string" || !entry.question_id || typeof entry.question !== "string" || typeof entry.question_type !== "string" || !(typeof entry.answer === "string" || (typeof entry.answer === "number" && Number.isFinite(entry.answer))) || !Array.isArray(entry.answer_session_ids) || !entry.answer_session_ids.every((id) => typeof id === "string" && id)) throw new Error("invalid dataset question shape");
  if (typeof entry.question_date !== "string" || ![entry.haystack_session_ids, entry.haystack_dates, entry.haystack_sessions].every(Array.isArray)) throw new Error("invalid dataset haystack shape");
  if (!normalizeDatasetDate(entry.question_date)) throw new Error(`invalid dataset question_date for ${entry.question_id}`);
  if (entry.haystack_session_ids.length !== entry.haystack_dates.length || entry.haystack_dates.length !== entry.haystack_sessions.length) throw new Error(`invalid haystack shape for ${entry.question_id}`);
  for (const [index, date] of entry.haystack_dates.entries()) { const id = entry.haystack_session_ids[index], turns = entry.haystack_sessions[index]; if (typeof id !== "string" || !id || !normalizeDatasetDate(date) || !Array.isArray(turns) || !turns.every((turn) => typeof turn?.role === "string" && typeof turn.content === "string")) throw new Error(`invalid dataset source for ${entry.question_id}/${String(id)}`); }
}
/** Selection and source preparation intentionally do not inspect answer fields. */
export function prepareCases(dataset: readonly RealEntry[], exposed: ReadonlySet<string>, limit?: number): { cases: PreparedCase[]; excluded_question_ids: string[] } {
  if (!Array.isArray(dataset) || (limit !== undefined && (!Number.isInteger(limit) || limit < 0))) throw new Error("invalid dataset or preparation limit");
  const ids = new Set<string>();
  for (const entry of dataset) { assertEntry(entry); if (ids.has(entry.question_id)) throw new Error(`duplicate question id: ${entry.question_id}`); ids.add(entry.question_id); }
  const selected = (limit === undefined ? dataset : dataset.filter((entry) => !exposed.has(entry.question_id)).slice(0, limit)).filter((entry) => !exposed.has(entry.question_id));
  return { excluded_question_ids: dataset.filter((entry) => exposed.has(entry.question_id)).map((entry) => entry.question_id), cases: selected.map((entry) => {
    const byId = new Map<string, string[]>();
    entry.haystack_session_ids.forEach((id: string, index: number) => byId.set(id, [...(byId.get(id) ?? []), normalizeDatasetDate(entry.haystack_dates[index]!)!]));
    const excluded_duplicate_sources = [...byId].filter(([, dates]) => dates.length > 1).map(([id, dates]) => ({ id, dates }));
    const duplicated = new Set(excluded_duplicate_sources.map(({ id }) => id));
    const source_rows: SourceRow[] = [], future_source_ids: string[] = [], questionDate = normalizeDatasetDate(entry.question_date)!;
    entry.haystack_session_ids.forEach((id: string, index: number) => { if (duplicated.has(id)) return; const date = normalizeDatasetDate(entry.haystack_dates[index]!)!; if (date > questionDate) future_source_ids.push(id); else source_rows.push({ id, date, text: rawSession(entry.haystack_sessions[index]!) }); });
    return { entry, excluded_duplicate_sources, source_rows, future_source_ids };
  }) };
}

export function sharedEvidence(rows: readonly SourceRow[]) { return baselineEvidence(rows, 20_000); }
export function fullEvidence(rows: readonly SourceRow[]) { return baselineEvidence(rows, 24_000); }
export function temporalEvidence(shared: string, assertions: string): string | null {
  const augmentation = `\n\nTemporal source assertions (experimental; not verified truth):\n${assertions}\n\n`;
  return augmentation.length <= 4_000 && shared.length + augmentation.length <= 24_000 ? `${shared}${augmentation}` : null;
}
export function validAnswer(value: unknown, allowed: readonly string[]): { answer: string; source_session_ids: string[] } | null {
  if (!isRecord(value) || typeof value.answer !== "string" || !value.answer.trim() || !Array.isArray(value.source_session_ids) || !value.source_session_ids.every((id) => typeof id === "string") || !(value.source_session_ids as string[]).every((id) => allowed.includes(id))) return null;
  return { answer: value.answer, source_session_ids: value.source_session_ids as string[] };
}
export function isCompleteAbstention(value: string): boolean { return /^(?:unknown|not enough information|insufficient information|cannot determine|i do not know|i don't know)[.!?]?$/.test(value.trim().toLowerCase()); }
export function validJudge(value: unknown, expected: readonly string[]): Map<string, boolean> | null {
  if (!isRecord(value) || !Array.isArray(value.scores) || value.scores.length !== expected.length) return null;
  const scores = new Map<string, boolean>();
  for (const score of value.scores) if (!isRecord(score) || typeof score.id !== "string" || typeof score.correct !== "boolean" || !expected.includes(score.id) || scores.has(score.id)) return null; else scores.set(score.id, score.correct);
  return scores.size === expected.length ? scores : null;
}
/** Converts opaque adapter sources back to retrieved session ids. Evidence is explicitly an excerpt, not a verified quote. */
export function sourceAssertions(facts: readonly { id?: string; event_id?: string; supersedes_id?: string | null; subject: string; predicate: string; value: string; valid_from: string; valid_to: string | null; observed_at: string; source: string | null; evidence: string }[], eventToSession: ReadonlyMap<string, string>): { text: string; facts: AssertionAudit[] } | null {
  if (!facts.length) return null;
  const mapped = facts.map((fact) => fact.source ? { fact, session: eventToSession.get(fact.source) } : null);
  if (mapped.some((item) => !item?.session)) return null;
  const audits = (mapped as Array<{ fact: typeof facts[number]; session: string }>).map(({ fact, session }) => ({ id: fact.id, event_id: fact.event_id, supersedes_id: fact.supersedes_id, subject: fact.subject, predicate: fact.predicate, value: fact.value, valid_from: fact.valid_from, valid_to: fact.valid_to, observed_at: fact.observed_at, source_event_id: fact.source!, source_session_id: session, evidence: fact.evidence, evidence_excerpt: fact.evidence.slice(0, 360) }));
  return { facts: audits, text: audits.map((fact) => `- ${fact.subject}.${fact.predicate} = ${fact.value} (valid_from: ${fact.valid_from}; valid_to: ${fact.valid_to ?? "open"}; observed_at: ${fact.observed_at}; source_session_id: ${fact.source_session_id}; evidence_excerpt: ${fact.evidence_excerpt})`).join("\n") };
}

export function clusterIds(entries: readonly RealEntry[]): Map<string, string> {
  const parent = new Map(entries.map((entry) => [entry.question_id, entry.question_id]));
  const find = (id: string): string => { const p = parent.get(id)!; if (p === id) return id; const root = find(p); parent.set(id, root); return root; };
  const join = (a: string, b: string) => { const left = find(a), right = find(b); if (left !== right) parent.set(right, left); };
  const owner = new Map<string, string>();
  for (const entry of entries) { const base = entry.question_id.replace(/_abs$/, ""); if (parent.has(base)) join(entry.question_id, base); for (const session of entry.answer_session_ids) { const first = owner.get(session); if (first) join(entry.question_id, first); else owner.set(session, entry.question_id); } }
  return new Map(entries.map((entry) => [entry.question_id, find(entry.question_id)]));
}
export function bootstrapDifference(pairs: readonly { id: string; cluster: string; candidate: boolean; control: boolean }[], seed = 20261018, samples = 10_000): { difference_pp: number | null; lower95_pp: number | null; upper95_pp: number | null; clusters: number; seed: number } {
  const groups = [...new Map<string, typeof pairs[number][]>(pairs.map((pair) => [pair.cluster, []])).entries()];
  for (const pair of pairs) groups.find(([id]) => id === pair.cluster)![1].push(pair);
  if (!pairs.length) return { difference_pp: null, lower95_pp: null, upper95_pp: null, clusters: groups.length, seed };
  const score = (items: readonly typeof pairs[number][]) => 100 * items.reduce((sum, item) => sum + Number(item.candidate) - Number(item.control), 0) / items.length;
  let state = seed >>> 0; const next = () => { state = (state + 0x6D2B79F5) >>> 0; let n = state; n = Math.imul(n ^ (n >>> 15), n | 1); n ^= n + Math.imul(n ^ (n >>> 7), n | 61); return ((n ^ (n >>> 14)) >>> 0) / 4_294_967_296; };
  const draws = Array.from({ length: samples }, () => score(Array.from({ length: groups.length }, () => groups[Math.floor(next() * groups.length)]![1]).flat())).sort((a, b) => a - b);
  return { difference_pp: score(pairs), lower95_pp: draws[Math.floor(samples * .025)]!, upper95_pp: draws[Math.ceil(samples * .975) - 1]!, clusters: groups.length, seed };
}
export function defaultPaths() { const here = fileURLToPath(new URL(".", import.meta.url)); return { dataset: `${here}data/longmemeval_s_cleaned.json`, exposure: [`${here}data/recall-lme-e5-n60.json`, `${here}data/temporal-public-real-2026-10-18.json`] }; }
export { seededShuffle };
