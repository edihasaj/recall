/**
 * Trusted speaker boundaries for LongMemEval sources. The manifest is rebuilt from the original
 * raw role/content messages (never from flattened text) and hash-bound to the raw dataset and the
 * prepared input, so a `user:` line inside an assistant message cannot become a fake user turn.
 * Only role and content are read; has_answer flags, references and question types are ignored.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EvidenceSpeakerSpan } from "../src/history/evidence.js";
import { sha256, type Case } from "./longmemeval-qa-support.js";

export const SOURCE_TURNS_KIND = "longmemeval-source-turns-v1";
export type SourceTurnSession = { id: string; date: string; text_sha256: string; occurrence: number; speaker_spans: EvidenceSpeakerSpan[] };
export type SourceTurns = {
  kind: typeof SOURCE_TURNS_KIND; input_sha256: string; raw_dataset_sha256: string;
  cases: { question_id: string; sessions: SourceTurnSession[] }[];
};
export type SourceTurnsReport = { path: string; sha256: string; input_sha256: string; raw_dataset_sha256: string; verified_cases: number };

const HEX = /^[0-9a-f]{64}$/;
const fail = (reason: string): never => { throw new Error(`Source turns: ${reason}`); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function parse(bytes: Buffer, what: string): unknown {
  try { return JSON.parse(bytes.toString()); } catch { return fail(`${what} is not valid JSON`); }
}

/** `${role}: ${content}` lines joined by one LF, with UTF-16 spans covering each whole rendered message. */
export function flattenTurns(turns: unknown): { text: string; spans: EvidenceSpeakerSpan[] } {
  if (!Array.isArray(turns)) return fail("session must be an array of messages");
  let text = "";
  const spans: EvidenceSpeakerSpan[] = [];
  for (const turn of turns) {
    if (!isRecord(turn)) return fail("message must be an object");
    const { role, content } = turn;
    if (role !== "user" && role !== "assistant") return fail("message role must be user or assistant");
    if (typeof content !== "string") return fail("message content must be a string");
    const line = `${role}: ${content}`;
    if (spans.length > 0) text += "\n";
    spans.push({ start: text.length, end: text.length + line.length, role });
    text += line;
  }
  return { text, spans };
}

/** Same tiling contract as the evidence renderer, restricted to the two LongMemEval roles. */
export function validateSpans(text: string, spans: unknown): EvidenceSpeakerSpan[] {
  if (!Array.isArray(spans)) return fail("speaker_spans must be an array");
  if (spans.length === 0) {
    if (text.length > 0) fail("speaker_spans must be nonempty for nonempty text");
    return [];
  }
  const out: EvidenceSpeakerSpan[] = [];
  let expected = 0;
  for (const [index, span] of spans.entries()) {
    if (!isRecord(span)) return fail("span must be an object");
    const { start, end, role } = span;
    if (typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end) {
      return fail("span offsets must be ordered integers");
    }
    if (role !== "user" && role !== "assistant") return fail("span role must be user or assistant");
    if (start !== expected || end > text.length) return fail("spans must tile the text");
    if (!text.startsWith(`${role}: `, start)) return fail("span must start with its role label");
    const last = index === spans.length - 1;
    if (last ? end !== text.length : text[end] !== "\n") return fail("spans must cover the text separated by one newline");
    out.push({ start, end, role });
    expected = end + 1;
  }
  return out;
}

/** Builds the manifest, proving the prepared input is exactly the flattened raw dataset. */
export function buildSourceTurns(rawBytes: Buffer, preparedBytes: Buffer): SourceTurns {
  const rawHash = sha256(rawBytes);
  const prepared = parse(preparedBytes, "prepared input");
  if (!isRecord(prepared) || !isRecord(prepared.provenance) || prepared.provenance.dataset_sha256 !== rawHash) {
    return fail("raw dataset hash does not match the prepared input provenance");
  }
  const raw = parse(rawBytes, "raw dataset");
  if (!Array.isArray(raw) || !Array.isArray(prepared.cases)) return fail("raw dataset and prepared cases must be arrays");
  if (raw.length !== prepared.cases.length) return fail("raw dataset and prepared input differ in question count");
  const rawById = new Map<string, Record<string, unknown>>();
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.question_id !== "string" || rawById.has(entry.question_id)) return fail("raw questions must have unique string IDs");
    rawById.set(entry.question_id, entry);
  }
  const done = new Set<string>();
  const cases: SourceTurns["cases"] = [];
  for (const candidate of prepared.cases as unknown[]) {
    if (!isRecord(candidate) || typeof candidate.question_id !== "string") return fail("prepared case is invalid");
    const id = candidate.question_id;
    const entry = rawById.get(id);
    if (!entry || done.has(id)) return fail("prepared and raw question IDs differ");
    done.add(id);
    const { haystack_session_ids: ids, haystack_dates: dates, haystack_sessions: turns } = entry;
    const sessions = candidate.sessions;
    if (!Array.isArray(ids) || !Array.isArray(dates) || !Array.isArray(turns) || !Array.isArray(sessions)
      || ids.length !== sessions.length || dates.length !== sessions.length || turns.length !== sessions.length) {
      return fail("session counts differ between raw and prepared input");
    }
    cases.push({
      question_id: id,
      sessions: sessions.map((session: unknown, occurrence): SourceTurnSession => {
        if (!isRecord(session) || typeof session.id !== "string" || typeof session.date !== "string" || typeof session.text !== "string") return fail("prepared session is invalid");
        if (ids[occurrence] !== session.id || dates[occurrence] !== session.date) return fail("session identity or date differs from the raw dataset");
        const flat = flattenTurns(turns[occurrence]);
        if (flat.text !== session.text) return fail("prepared session text differs from the flattened raw messages");
        return { id: session.id, date: session.date, text_sha256: sha256(session.text), occurrence, speaker_spans: validateSpans(flat.text, flat.spans) };
      }),
    });
  }
  return { kind: SOURCE_TURNS_KIND, input_sha256: sha256(preparedBytes), raw_dataset_sha256: rawHash, cases };
}

/** Reads a manifest file and checks its shape; hash binding to the input happens in applySourceTurns. */
export function loadSourceTurns(path: string): { manifest: SourceTurns; path: string; sha256: string } {
  const bytes = readFileSync(path);
  const value = parse(bytes, "manifest");
  if (!isRecord(value) || value.kind !== SOURCE_TURNS_KIND) return fail("unsupported manifest kind");
  if (typeof value.input_sha256 !== "string" || !HEX.test(value.input_sha256)
    || typeof value.raw_dataset_sha256 !== "string" || !HEX.test(value.raw_dataset_sha256) || !Array.isArray(value.cases)) {
    return fail("manifest hashes or cases are invalid");
  }
  const ids = new Set<string>();
  for (const item of value.cases) {
    if (!isRecord(item) || typeof item.question_id !== "string" || ids.has(item.question_id) || !Array.isArray(item.sessions)) return fail("manifest case is invalid");
    ids.add(item.question_id);
    for (const s of item.sessions) {
      if (!isRecord(s) || typeof s.id !== "string" || typeof s.date !== "string" || typeof s.text_sha256 !== "string" || !HEX.test(s.text_sha256)
        || !Number.isInteger(s.occurrence) || !Array.isArray(s.speaker_spans)) return fail("manifest session is invalid");
    }
  }
  return { manifest: value as unknown as SourceTurns, path, sha256: sha256(bytes) };
}

/**
 * Verifies the manifest against the exact input, then returns copies of the selected cases whose
 * sessions carry validated speaker spans. The input and the original cases are never mutated.
 */
export function applySourceTurns(
  input: { provenance: Record<string, unknown>; trial_subset?: unknown },
  inputBytes: Buffer,
  loaded: { manifest: SourceTurns; path: string; sha256: string },
  selected: Case[],
): { cases: Case[]; report: SourceTurnsReport } {
  const { manifest } = loaded;
  if (manifest.raw_dataset_sha256 !== input.provenance.dataset_sha256) return fail("manifest raw dataset does not match the input provenance");
  const parent = isRecord(input.trial_subset) ? input.trial_subset.parent_sha256 : undefined;
  if (manifest.input_sha256 !== sha256(inputBytes) && manifest.input_sha256 !== parent) return fail("manifest is not bound to this input");
  const byId = new Map(manifest.cases.map((item) => [item.question_id, item]));
  const cases = selected.map((item): Case => {
    const entry = byId.get(item.question_id);
    if (!entry || entry.sessions.length !== item.sessions.length) return fail("manifest does not cover a selected question");
    return {
      ...item,
      sessions: item.sessions.map((session, occurrence) => {
        const turns = entry.sessions[occurrence]!;
        if (turns.occurrence !== occurrence || turns.id !== session.id || turns.date !== session.date || turns.text_sha256 !== sha256(session.text)) {
          return fail("manifest session fingerprint does not match the input");
        }
        return { ...session, speaker_spans: validateSpans(session.text, turns.speaker_spans) };
      }),
    };
  });
  return {
    cases,
    report: {
      path: loaded.path, sha256: loaded.sha256, input_sha256: manifest.input_sha256,
      raw_dataset_sha256: manifest.raw_dataset_sha256, verified_cases: cases.length,
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!, process.argv[i + 1] ?? "");
  const [raw, prepared, out] = ["--raw", "--prepared", "--out"].map((key) => args.get(key));
  if (!raw || !prepared || !out) {
    console.error("Usage: tsx benchmark/longmemeval-source-turns.ts --raw RAW.json --prepared PREPARED.json --out MANIFEST.json");
    process.exitCode = 2;
  } else {
    const manifest = buildSourceTurns(readFileSync(raw), readFileSync(prepared));
    writeFileSync(out, JSON.stringify(manifest), { flag: "wx" });
    console.log(JSON.stringify({ out, cases: manifest.cases.length, input_sha256: manifest.input_sha256, raw_dataset_sha256: manifest.raw_dataset_sha256 }));
  }
}
