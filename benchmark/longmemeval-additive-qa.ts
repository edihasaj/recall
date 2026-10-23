/**
 * QA wiring for the opt-in `--evidence additive` mode: protocol validation before any
 * credential or call, row evidence and scorer-side diagnostics, and report metadata.
 * Lexical order comes from the question only; gold labels are used afterwards for coverage.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ADDITIVE_BASE_CAP, ADDITIVE_EXTRA_CAP, ADDITIVE_FRAMED_CAP, ADDITIVE_LEXICAL_LIMIT,
  ADDITIVE_ORIGINAL_COUNT, ADDITIVE_RAW_UNIT_CAP, ADDITIVE_SOURCE_LIMIT, ADDITIVE_TOTAL_CAP,
  buildAdditiveLexicalEvidence,
} from "./longmemeval-additive-evidence.js";
import { lexicalRank, sha256, type Case, type Ranked, type Ranking } from "./longmemeval-qa-support.js";
import type { Options } from "./longmemeval-qa.js";

export type AdditiveEvidence = ReturnType<typeof buildAdditiveLexicalEvidence>;
export const ADDITIVE_LEXICAL_POOL = 80;

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
/** Code that determines additive evidence, hashed into the report beside the base QA files. */
export const additiveCodePaths = () => [
  here("./longmemeval-additive-qa.ts"),
  here("./longmemeval-additive-evidence.ts"),
  here("./longmemeval-supplemental-evidence.ts"),
];

/** Rejects every unsupported additive combination before credentials, files or calls. */
export function validateAdditiveOptions(options: Options, hasCalls: boolean): void {
  if (options.retrieval !== "cached") throw new Error("Additive evidence requires cached retrieval");
  if (options.topK !== 20) throw new Error("Additive evidence requires --top-k 20");
  if (options.contextChars !== ADDITIVE_BASE_CAP) throw new Error("Additive evidence requires --context-chars 180000");
  if (options.evidenceLedger && options.evidenceLedger !== "none") throw new Error("Additive evidence cannot use an evidence ledger");
  if (options.answerSamples !== undefined && options.answerSamples !== 1) throw new Error("Additive evidence requires a single answer sample");
  if (options.answerProvider) throw new Error("Additive evidence cannot use the Azure answer provider");
  if (options.answerCheck === "grounded") throw new Error("Additive evidence cannot use grounded answer checks");
  if (options.concurrency > 3) throw new Error("Additive evidence concurrency must be at most three");
  if (!hasCalls) return;
  if (options.provider !== "qwen-local") throw new Error("Additive evidence requires qwen-local");
  if (options.requestMode !== "robust" || options.evidencePolicy !== "system") throw new Error("Additive evidence calls require robust requests and system evidence policy");
  if (options.reasoningEffort !== "adaptive" || options.maxOutputTokens !== 16_384) throw new Error("Additive evidence calls require adaptive reasoning and a 16384-token answer budget");
  if (options.answerPolicy !== "minimal" || options.answerCheck !== "premise") throw new Error("Additive evidence calls require the minimal answer policy and a premise check");
  if (options.answerRecovery !== "longer-timeout-transport") throw new Error("Additive evidence calls require longer-timeout-transport answer recovery");
}

/** Exact original occurrences are mandatory so the original twenty are never re-derived from IDs. */
export function validateAdditiveRankings(rankById: Map<string, Ranking>, selected: Case[]): void {
  for (const item of selected) {
    const ranking = rankById.get(item.question_id);
    if (!ranking) throw new Error("Additive evidence requires a ranking for every selected question");
    if (ranking.retrieved_session_occurrences === undefined) throw new Error("Additive evidence requires exact ranking occurrences");
    if (ranking.retrieved_session_ids.length < ADDITIVE_ORIGINAL_COUNT) throw new Error("Additive evidence requires exactly 20 ranked sources per selected question");
  }
}

/** Original twenty plus the lexical sources that actually reached the rendered context. */
export const additiveCoveredIds = (evidence: { sources: { id: string; used_chars: number }[] }): string[] =>
  evidence.sources.filter((source, index) => index < ADDITIVE_ORIGINAL_COUNT || source.used_chars > 0).map((source) => source.id);

export function additiveEvidence(item: Case, ranked: Ranked[], exact: boolean):
  | { error: string } | { evidence: AdditiveEvidence; diagnostics: ReturnType<typeof additiveDiagnostics> } {
  if (!exact || ranked.length !== ADDITIVE_ORIGINAL_COUNT) return { error: "additive_ranking_incomplete" };
  const evidence = buildAdditiveLexicalEvidence(ranked, lexicalRank(item.question, item.sessions, ADDITIVE_LEXICAL_POOL), item.question);
  return { evidence, diagnostics: additiveDiagnostics(item, evidence) };
}

/** Scorer metadata. Gold only measures coverage of what the fixed rule already selected. */
export function additiveDiagnostics(item: Case, evidence: AdditiveEvidence) {
  const original = new Set(evidence.sources.slice(0, ADDITIVE_ORIGINAL_COUNT).map((source) => source.id));
  const selected = new Set(evidence.sources.slice(ADDITIVE_ORIGINAL_COUNT).map((source) => source.id));
  const included = new Set(additiveCoveredIds(evidence).slice(ADDITIVE_ORIGINAL_COUNT));
  const gold = item.is_abstention ? [] : item.gold_session_ids;
  const any = (ids: Set<string>) => gold.some((id) => ids.has(id));
  return {
    ...evidence.additive,
    lexical_pool: ADDITIVE_LEXICAL_POOL,
    appended_sources: evidence.sources.length - ADDITIVE_ORIGINAL_COUNT,
    gold_source_coverage: gold.length === 0 ? null : {
      original_any: any(original), original_all: gold.every((id) => original.has(id)),
      appended_selected_any: any(selected), appended_included_any: any(included),
      combined_any: any(new Set([...original, ...included])),
      combined_all: gold.every((id) => original.has(id) || included.has(id)),
    },
  };
}

export const ADDITIVE_LIMITATION = "Additive evidence is one combined treatment of three changes: extra lexical sources, an extra-source representation (neutral Lexical Memory N labels with complete query-focused units, preferred-speaker reservation, 4000-character framing and a 3800-character raw-unit ceiling), and a larger context budget (up to 260,000 characters). The original twenty ranked sources and their 180,000-character rendering remain an exact prefix; up to twenty distinct lexical sources from the question's top-80 production FTS results are appended under a separate 80,000-character budget. Gains cannot be attributed to any one of the three. Source selection and rendering use only the question and source text; gold IDs and references never choose sources and appear only in scorer diagnostics. Neither source coverage nor delivered ranges prove the answer fact is present.";

export function additiveReport() {
  return {
    mode: "original_twenty_plus_lexical",
    base_chars: ADDITIVE_BASE_CAP, extra_chars: ADDITIVE_EXTRA_CAP, total_chars_cap: ADDITIVE_TOTAL_CAP,
    source_limit: ADDITIVE_SOURCE_LIMIT, original_sources: ADDITIVE_ORIGINAL_COUNT,
    lexical_pool: ADDITIVE_LEXICAL_POOL, lexical_limit: ADDITIVE_LEXICAL_LIMIT,
    per_source_chars: ADDITIVE_FRAMED_CAP, raw_unit_chars: ADDITIVE_RAW_UNIT_CAP,
    helper_source_sha256: sha256(readFileSync(here("./longmemeval-additive-evidence.ts"))),
    renderer_source_sha256: sha256(readFileSync(here("./longmemeval-supplemental-evidence.ts"))),
    diagnostics: "Recorded in each result's additive_diagnostics and supplemental_diagnostics fields.",
  };
}
