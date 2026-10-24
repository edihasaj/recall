/**
 * QA wiring for the opt-in `--evidence statements` mode: it shares the additive protocol
 * validation, then reports statement-evidence diagnostics and fixed settings. The helper
 * selects from the question and source text only; gold IDs appear solely in the coverage
 * diagnostics, which count only sources that actually reached the rendered context.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateAdditiveOptions, validateAdditiveRankings } from "./longmemeval-additive-qa.js";
import { applySourceTurns, loadSourceTurns } from "./longmemeval-source-turns.js";
import { lexicalRank, sha256, type Case, type Ranked, type Ranking } from "./longmemeval-qa-support.js";
import type { Options } from "./longmemeval-qa.js";
import {
  STATEMENT_LEXICAL_LIMIT, STATEMENT_LEXICAL_POOL, STATEMENT_MAX_CHARS, STATEMENT_ORIGINAL_COUNT,
  STATEMENT_PER_SOURCE_CHARS, buildStatementEvidence,
} from "./longmemeval-statement-evidence.js";

export type StatementEvidence = ReturnType<typeof buildStatementEvidence>;
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
/** Code that determines statement evidence, hashed into the report beside the base QA files. */
export const statementCodePaths = () => [
  here("./longmemeval-statement-qa.ts"),
  here("./longmemeval-statement-evidence.ts"),
  here("./longmemeval-source-turns.ts"),
  here("../src/history/evidence.ts"),
];

/** Runs before any file, credential or call: --source-turns belongs to statements mode only, and statements requires it. */
export function validateStatementOptions(options: Options, hasCalls: boolean): void {
  if (options.evidence !== "statements") {
    if (options.sourceTurns !== undefined) throw new Error("--source-turns is only valid with --evidence statements");
    return;
  }
  if (!options.sourceTurns) throw new Error("Statement evidence requires --source-turns");
  validateAdditiveOptions(options, hasCalls, "Statement");
}

/** Loads and verifies the manifest against the exact input; returns enriched copies of the selected cases. */
export const attachSourceTurns = (path: string, input: Parameters<typeof applySourceTurns>[0], inputBytes: Buffer, selected: Case[]) =>
  applySourceTurns(input, inputBytes, loadSourceTurns(path), selected);
export const validateStatementRankings = (rankById: Map<string, Ranking>, selected: Case[]) => validateAdditiveRankings(rankById, selected, "Statement");

/** Sources whose text reached the rendered context; sources the budget dropped never count. */
export const statementCoveredIds = (evidence: { sources: { id: string; used_chars: number }[] }): string[] =>
  evidence.sources.filter((source) => source.used_chars > 0).map((source) => source.id);

/** Scorer metadata. Gold only measures coverage of what the fixed rule already selected. */
export function statementDiagnostics(item: Case, evidence: StatementEvidence) {
  const used = (from: number, to?: number) => new Set(evidence.sources.slice(from, to).filter((source) => source.used_chars > 0).map((source) => source.id));
  const original = used(0, STATEMENT_ORIGINAL_COUNT), included = used(STATEMENT_ORIGINAL_COUNT);
  const selected = new Set(evidence.sources.slice(STATEMENT_ORIGINAL_COUNT).map((source) => source.id));
  const gold = item.is_abstention ? [] : item.gold_session_ids;
  const any = (ids: Set<string>) => gold.some((id) => ids.has(id));
  return {
    ...evidence.statements,
    lexical_pool: STATEMENT_LEXICAL_POOL,
    appended_sources: evidence.sources.length - STATEMENT_ORIGINAL_COUNT,
    rendered_sources: statementCoveredIds(evidence).length,
    gold_source_coverage: gold.length === 0 ? null : {
      original_any: any(original), original_all: gold.every((id) => original.has(id)),
      appended_selected_any: any(selected), appended_included_any: any(included),
      combined_any: any(new Set([...original, ...included])),
      combined_all: gold.every((id) => original.has(id) || included.has(id)),
    },
  };
}

export function statementEvidence(item: Case, ranked: Ranked[], exact: boolean):
  | { error: string } | { evidence: StatementEvidence; diagnostics: ReturnType<typeof statementDiagnostics> } {
  if (!exact || ranked.length !== STATEMENT_ORIGINAL_COUNT) return { error: "statement_ranking_incomplete" };
  const evidence = buildStatementEvidence(ranked, lexicalRank(item.question, item.sessions, STATEMENT_LEXICAL_POOL), item.question);
  return { evidence, diagnostics: statementDiagnostics(item, evidence) };
}

export const STATEMENT_LIMITATION = "Statement evidence is one combined treatment: the same twenty ranked sources plus up to twenty distinct sources from the question's top-80 production FTS results are all rendered chronologically under neutral Memory N labels with one shared 180,000-character budget, a 4000-character per-source ceiling and preferred-speaker statement reservation. It differs from additive evidence in representation and budget (no 260,000-character allowance, no exact original-twenty prefix), so gains cannot be attributed to any single change. Speaker boundaries come from a hash-bound manifest rebuilt from the original raw role/content messages, never from flattened text. Selection and rendering use only the question and source text; gold IDs and references appear only in scorer diagnostics, and coverage counts only sources with rendered text. Neither source coverage nor delivered ranges prove the answer fact is present.";

export function statementReport() {
  return {
    mode: "original_twenty_plus_lexical_statements",
    original_sources: STATEMENT_ORIGINAL_COUNT, lexical_pool: STATEMENT_LEXICAL_POOL, lexical_limit: STATEMENT_LEXICAL_LIMIT,
    per_source_raw_chars: STATEMENT_PER_SOURCE_CHARS, max_chars: STATEMENT_MAX_CHARS, reserve_speaker_units: true,
    helper_source_sha256: sha256(readFileSync(here("./longmemeval-statement-evidence.ts"))),
    renderer_source_sha256: sha256(readFileSync(here("../src/history/evidence.ts"))),
    diagnostics: "Recorded in each result's statements_diagnostics field.",
  };
}
