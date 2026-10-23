/** Builds the blinded, saved-context input for the LongMemEval replay diagnostic. */
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { answerPrompt, sha256, type Case } from "./longmemeval-qa-support.js";

export const CONTEXT_REPLAY_CAP = 210_000;
export type Replacement = { kind: "source" | "question"; original_sha256: string; alias: string; occurrences: number };
export type SanitizedContext = {
  text: string; replacements: Replacement[]; sha256: string; utf16_chars: number;
};
export type ReplaySide = {
  name: "recall" | "hindsight"; context: string; context_sha256: string; context_utf16_chars: number;
  replacements: Replacement[];
};
export type ReplayCase = {
  index: number; question_id: string; question_type: string; is_abstention: boolean;
  generation: Pick<Case, "question" | "answer_prompt_prefix">;
  judge_case: Case; sides: Record<ReplaySide["name"], ReplaySide>;
};
export type ContextReplayInput = {
  selected_question_ids: string[]; cases: ReplayCase[];
  source_canonical_sha256: Record<string, string>;
  generation_blinding: string;
};

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): UnknownRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid replay input shape");
  return value as UnknownRecord;
};
const strings = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item)) throw new Error(`Invalid ${label}`);
  return value as string[];
};
const unique = (ids: string[], label: string) => {
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${label}`);
};
const utf16 = (text: string) => text.length;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.entries(value as UnknownRecord).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
  : JSON.stringify(value) ?? "null";
type Identifier = { id: string; kind: "source" | "question" };
type Matcher = { lookup: Map<string, Identifier>; expression: RegExp };

function identifiers(sourceIds: readonly string[], questionIds: readonly string[]): Matcher {
  const values = [
    ...sourceIds.map((id) => ({ id, kind: "source" as const })),
    ...questionIds.map((id) => ({ id, kind: "question" as const })),
  ].sort((a, b) => b.id.length - a.id.length || a.id.localeCompare(b.id));
  return { lookup: new Map(values.map((entry) => [entry.id, entry])), expression: new RegExp(values.map((entry) => escape(entry.id)).join("|"), "g") };
}

/**
 * Replaces only known identifiers. Alternation order prevents short known IDs
 * from consuming the start of a longer qualified ID; aliases follow first
 * appearance in this context, never corpus source order.
 */
export function sanitizeContext(text: string, sourceIds: readonly string[], questionIds: readonly string[]): SanitizedContext {
  if (typeof text !== "string") throw new Error("Invalid published context");
  unique([...sourceIds], "source IDs"); unique([...questionIds], "question IDs");
  return sanitizeWithMatcher(text, identifiers(sourceIds, questionIds));
}
function sanitizeWithMatcher(text: string, matcher: Matcher): SanitizedContext {
  if (!matcher.lookup.size) return { text, replacements: [], sha256: sha256(text), utf16_chars: utf16(text) };
  const aliases = new Map<string, string>();
  const replacements: Replacement[] = [];
  const sanitized = text.replace(matcher.expression, (matched) => {
    const entry = matcher.lookup.get(matched)!;
    let alias = aliases.get(matched);
    if (!alias) {
      alias = `${entry.kind}-neutral-${aliases.size + 1}`;
      aliases.set(matched, alias);
      replacements.push({ kind: entry.kind, original_sha256: sha256(matched), alias, occurrences: 0 });
    }
    replacements.find((replacement) => replacement.alias === alias)!.occurrences++;
    return alias;
  });
  return { text: sanitized, replacements, sha256: sha256(sanitized), utf16_chars: utf16(sanitized) };
}

function exactOrder(actual: string[], expected: string[], label: string) {
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    throw new Error(`${label} identity/order mismatch`);
  }
}
function cap(text: string, label: string) {
  if (utf16(text) > CONTEXT_REPLAY_CAP) throw new Error(`${label} exceeds ${CONTEXT_REPLAY_CAP} UTF-16 characters`);
}
function noOriginalIdentifiers(text: string, matcher: Matcher, label: string) {
  matcher.expression.lastIndex = 0;
  if (matcher.expression.test(text)) throw new Error(`${label} retains original identifier`);
}

export function buildContextReplayInput(args: {
  prepared: unknown; recall: unknown; published: unknown; raw: unknown; expectedIds: unknown;
}): ContextReplayInput {
  const prepared = record(args.prepared), recall = record(args.recall), published = record(args.published);
  const expectedRoot = Array.isArray(args.expectedIds) ? { selected_ids: args.expectedIds } : record(args.expectedIds);
  const expected = strings(expectedRoot.selected_ids, "expected selected IDs");
  if (expected.length !== 60) throw new Error("Expected exactly 60 question IDs");
  unique(expected, "expected selected IDs");
  const preparedCases = prepared.cases as Case[];
  if (!Array.isArray(preparedCases) || !preparedCases.every((item) => item && typeof item.question_id === "string")) throw new Error("Invalid prepared cases");
  const preparedIds = preparedCases.map((item) => item.question_id); unique(preparedIds, "prepared question IDs");
  const preparedById = new Map(preparedCases.map((item) => [item.question_id, item]));
  const selected = expected.map((id) => {
    const item = preparedById.get(id);
    if (!item) throw new Error("Expected question missing from prepared input");
    if (item.answer_prompt_prefix.split("__RECALL_CONTEXT__").length !== 2) throw new Error("Invalid prepared answer prompt marker");
    return item;
  });
  if (selected.some((item) => item.is_abstention)) throw new Error("Selected replay cohort must contain no abstentions");

  if (recall.status !== "complete" || recall.comparison_valid !== true) throw new Error("Recall report is not a completed blinded run");
  exactOrder(strings(recall.selected_question_ids, "Recall selected IDs"), expected, "Recall selected IDs");
  const recallRows = recall.results;
  if (!Array.isArray(recallRows)) throw new Error("Recall results missing");
  const recallById = new Map<string, UnknownRecord>();
  for (const value of recallRows) {
    const row = record(value); const id = row.question_id;
    if (typeof id !== "string" || recallById.has(id)) throw new Error("Duplicate Recall result");
    recallById.set(id, row);
  }
  exactOrder(recallRows.map((value) => record(value).question_id).filter((id): id is string => typeof id === "string"), expected, "Recall result rows");

  const rawRows = args.raw;
  if (!Array.isArray(rawRows)) throw new Error("Raw corpus missing");
  const rawById = new Map<string, UnknownRecord>();
  for (const value of rawRows) {
    const row = record(value);
    if (typeof row.question_id !== "string" || rawById.has(row.question_id)) throw new Error("Invalid raw corpus question identities");
    rawById.set(row.question_id, row);
  }
  const allSourceIds = [...new Set(rawRows.flatMap((value) => strings(record(value).haystack_session_ids, "raw source IDs")))];
  const allQuestionIds = [...rawById.keys()];
  const allIdentifiers = identifiers(allSourceIds, allQuestionIds);

  const publishedResults = published.results;
  if (!Array.isArray(publishedResults)) throw new Error("Published results missing");
  const publishedById = new Map<string, UnknownRecord>();
  for (const value of publishedResults) {
    const row = record(value); const id = row.query_id;
    if (typeof id !== "string" || publishedById.has(id)) throw new Error("Invalid published question identities");
    publishedById.set(id, row);
  }

  const cases = selected.map((item, index): ReplayCase => {
    const raw = rawById.get(item.question_id), recallRow = recallById.get(item.question_id), publishedRow = publishedById.get(item.question_id);
    if (!raw || !recallRow || !publishedRow) throw new Error("Selected question missing from source artifact");
    if (raw.question !== item.question || publishedRow.query !== item.question) throw new Error("Question text mismatch");
    const evidence = record(recallRow.evidence);
    if (typeof evidence.text !== "string") throw new Error("Recall evidence text missing");
    const answerCall = record(recallRow.answer_call);
    if (typeof answerCall.prompt_sha256 !== "string" || answerCall.prompt_sha256 !== sha256(answerPrompt(item, evidence.text))) {
      throw new Error("Recall answer prompt hash mismatch");
    }
    if (!Array.isArray(evidence.sources)) throw new Error("Recall source metadata missing");
    for (const sourceValue of evidence.sources) {
      const source = record(sourceValue), occurrence = source.occurrence;
      if (typeof source.id !== "string" || typeof occurrence !== "number" || !Number.isInteger(occurrence) || occurrence < 0 || occurrence >= item.sessions.length) throw new Error("Recall source identity invalid");
      const session = item.sessions[occurrence]!;
      if (source.id !== session.id || (typeof source.date === "string" && source.date !== session.date)) throw new Error("Recall source identity mismatch");
    }
    cap(evidence.text, "Recall context");
    noOriginalIdentifiers(evidence.text, allIdentifiers, "Recall context");
    if (typeof publishedRow.context !== "string") throw new Error("Published context missing");
    cap(publishedRow.context, "Published raw context");
    const hindsight = sanitizeWithMatcher(publishedRow.context, allIdentifiers);
    cap(hindsight.text, "Hindsight context");
    noOriginalIdentifiers(hindsight.text, allIdentifiers, "Hindsight context");
    const recallPrompt = answerPrompt(item, evidence.text), hindsightPrompt = answerPrompt(item, hindsight.text);
    noOriginalIdentifiers(recallPrompt, allIdentifiers, "Recall generation prompt");
    noOriginalIdentifiers(hindsightPrompt, allIdentifiers, "Hindsight generation prompt");
    return {
      index, question_id: item.question_id, question_type: item.question_type, is_abstention: item.is_abstention,
      generation: { question: item.question, answer_prompt_prefix: item.answer_prompt_prefix },
      judge_case: { ...item, sessions: item.sessions.map((session) => ({ ...session })), gold_session_ids: [...item.gold_session_ids] },
      sides: {
        recall: { name: "recall", context: evidence.text, context_sha256: sha256(evidence.text), context_utf16_chars: utf16(evidence.text), replacements: [] },
        hindsight: { name: "hindsight", context: hindsight.text, context_sha256: hindsight.sha256, context_utf16_chars: hindsight.utf16_chars, replacements: hindsight.replacements },
      },
    };
  });
  return {
    selected_question_ids: expected, cases,
    source_canonical_sha256: {
      prepared_canonical_json: sha256(canonical(args.prepared)), recall_canonical_json: sha256(canonical(args.recall)),
      published_canonical_json: sha256(canonical(args.published)), raw_canonical_json: sha256(canonical(args.raw)),
      expected_ids_canonical_json: sha256(canonical(args.expectedIds)),
    },
    generation_blinding: "Generation receives only the pinned prepared answer template, saved context and question metadata. References, gold IDs, categories, historical outcomes and original identifiers are excluded.",
  };
}

/** Convenience loader for the frozen local inputs; it performs no model calls. */
export function loadDefaultContextReplayInput(root = process.cwd()): ContextReplayInput {
  const json = (path: string) => JSON.parse(readFileSync(`${root}/${path}`, "utf8")) as unknown;
  return buildContextReplayInput({
    prepared: json("benchmark/data/longmemeval-amb-input-2026-10-19.json"),
    recall: json("benchmark/data/longmemeval-supplemental-development60-2026-10-20.json"),
    published: JSON.parse(gunzipSync(readFileSync(`${root}/benchmark/data/hindsight-comparison-2026-10-19/s.json.gz`)).toString()),
    raw: json("benchmark/data/longmemeval_s_cleaned.json"),
    expectedIds: json("benchmark/data/longmemeval-fresh-e5-fixed60-manifest-2026-10-19.json"),
  });
}
