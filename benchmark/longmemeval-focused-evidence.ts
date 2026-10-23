/** The application's verbatim evidence renderer over benchmark session text. */
import { preferredEvidenceSpeaker, renderEvidenceSources } from "../src/history/evidence.js";
import { HISTORY_EVIDENCE_POLICY } from "../src/history/evidence-policy.js";
import type { Ranked } from "./longmemeval-qa-support.js";

/**
 * The corpus uses YYYY/MM/DD (weekday) HH:mm. Preserve its actual observation
 * clock rather than treating it as the date of every event mentioned in a turn.
 */
export function corpusObservationDate(date: string): string | undefined {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})(?:\s+\([A-Za-z]{3}\))?(?:\s+(\d{2}):(\d{2}))?$/.exec(date.trim());
  if (!match) return date;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4] ?? "00"}:${match[5] ?? "00"}:00Z`;
}

export const EVIDENCE_USE_GUIDANCE = HISTORY_EVIDENCE_POLICY;

export function buildFocusedEvidence(rows: Ranked[], question: string, cap: number, includeGuidance = true) {
  const prefix = includeGuidance ? `${EVIDENCE_USE_GUIDANCE}\n\n` : "";
  if (cap < prefix.length) throw new Error("Evidence guidance exceeds context cap");
  const rendered = renderEvidenceSources(rows.map((row) => ({
    text: row.text, observed_at: corpusObservationDate(row.date),
  })), {
    query: question, max_chars: cap - prefix.length, per_source_chars: 4000,
    preferred_speaker: preferredEvidenceSpeaker(question),
  });
  const text = prefix + rendered.text;
  return {
    text, chars: text.length,
    full_chars: text.length + rendered.sources.reduce(
      (sum, source) => sum + source.full_chars - source.used_chars, 0),
    sources: rendered.sources.map((source) => {
      const row = rows[source.source_index]!;
      return {
        id: row.id, occurrence: row.occurrence, date: row.date,
        full_chars: source.full_chars, used_chars: source.used_chars,
        truncated: source.truncated, ranges: source.ranges,
      };
    }),
  };
}
