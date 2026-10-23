/**
 * Opt-in scope-aware review policy for the abstention-recovery replay. The default "original" policy leaves the
 * existing review prompt byte-for-byte unchanged; "scope" inserts one fixed instruction block ahead of the untrusted
 * record. The instruction is generic: it carries no question, ID, label, reference or gold-derived exception.
 */
import { answerGenerationClock, answerTaskContract, groundedAnswerReviewPrompt } from "./longmemeval-answer-review.js";
import { sha256, type Case } from "./longmemeval-qa-support.js";

export const REVIEW_POLICIES = ["original", "scope"] as const;
export type ReviewPolicy = (typeof REVIEW_POLICIES)[number];

export const SCOPE_REVIEW_INSTRUCTION = [
  "Answer exactly what the question asks. Require evidence for the exact entity, role, employer, relation and time period it names.",
  "When the evidence does not support the exact asked item, say plainly that it is not recorded. Never offer a different employer, role, person or computed alternative in its place, and never perform alternative calculations once the asked subject is unsupported.",
  "Do not assume the user's identity or role from a shared timeline, from another person's events, or from a topic merely being discussed.",
  "Role-play, drafted text and assistant-authored messages (for example a recruiter message written by the assistant) are not the user's own biography. Attribute each fact to who actually stated it.",
  "Give only the requested fact plus the essential qualification of its source. Remove draft paragraphs, recommendations and side calculations that the question did not ask for.",
  "For a count over a union of categories, count the supported members of the categories asked; a category with no supported member is not a reason to withhold the count.",
].join("\n");
export const SCOPE_REVIEW_INSTRUCTION_SHA256 = sha256(SCOPE_REVIEW_INSTRUCTION);

const MARKER = "\n\nUNTRUSTED_RECORD_JSON\n";

export function parseReviewPolicy(value: string | undefined): ReviewPolicy {
  if (value === undefined) return "original";
  if (!(REVIEW_POLICIES as readonly string[]).includes(value)) throw new Error("Invalid review policy");
  return value as ReviewPolicy;
}

export const policyProvenance = (policy: ReviewPolicy) => ({
  name: policy, instruction_sha256: policy === "scope" ? SCOPE_REVIEW_INSTRUCTION_SHA256 : null,
});

/**
 * The review prompt for a policy. Inputs are only the question, clock, evidence, draft and task contract; question IDs,
 * labels, references and gold data never reach this builder. The marker sits in the fixed template, ahead of the
 * JSON-escaped record, and must occur exactly once so untrusted text cannot move the inserted block.
 */
export function reviewPrompt(
  policy: ReviewPolicy, question: string, clock: string, evidence: string, draft: string, contract: string,
): string {
  const base = groundedAnswerReviewPrompt(question, clock, evidence, draft, contract);
  if (policy === "original") return base;
  const parts = base.split(MARKER);
  if (parts.length !== 2) throw new Error("review_prompt_marker_unexpected");
  return `${parts[0]}\n\nSCOPE_REVIEW_REQUIREMENTS\n${SCOPE_REVIEW_INSTRUCTION}\nEND_SCOPE_REVIEW_REQUIREMENTS${MARKER}${parts[1]}`;
}

export const caseReviewPrompt = (policy: ReviewPolicy, item: Case, evidence: string, draft: string) =>
  reviewPrompt(policy, item.question, answerGenerationClock(item.answer_prompt_prefix), evidence, draft, answerTaskContract(item.answer_prompt_prefix));

export type PairRow = {
  question_id: string; is_abstention: boolean; baseline_correct: boolean; draft_answer: string | null;
  evidence: { text: string } | null; replay_correct: boolean | null; error: string | null;
  review_policy?: string; review_instruction_sha256?: string | null; review_prompt_sha256: string | null;
};
const HEX64 = /^[0-9a-f]{64}$/;
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * Pair a control run with a scope run over the frozen cohort. Every expected ID is scored in both arms; a failed,
 * malformed or missing row counts incorrect, so net always equals scope_correct - control_correct. The pair is valid
 * only when both arms hold exactly the expected IDs, each row is complete and error-free with a boolean verdict, the
 * policy metadata matches, and drafts, evidence and baseline fields agree while the prompt hashes differ.
 */
export function pairPolicyRuns(expectedIds: string[], control: PairRow[], scope: PairRow[]) {
  const problems: string[] = [];
  if (!expectedIds.length || new Set(expectedIds).size !== expectedIds.length) problems.push("expected IDs empty or duplicated");
  const expected = new Set(expectedIds);
  const arms = { original: control, scope } as const;
  const index = (rows: PairRow[], label: string) => {
    const map = new Map<string, PairRow>();
    for (const row of rows) {
      if (!expected.has(row.question_id)) problems.push(`${label} unexpected ${row.question_id}`);
      else if (map.has(row.question_id)) problems.push(`${label} duplicate ${row.question_id}`);
      else map.set(row.question_id, row);
    }
    for (const id of expectedIds) if (!map.has(id)) problems.push(`${label} missing ${id}`);
    return map;
  };
  const maps = { original: index(control, "control"), scope: index(scope, "scope") };
  const wantSha = { original: null, scope: SCOPE_REVIEW_INSTRUCTION_SHA256 } as const;
  for (const [policy, map] of Object.entries(maps) as ["original" | "scope", Map<string, PairRow>][]) {
    for (const [id, row] of map) {
      const bad = (what: string) => problems.push(`${policy} ${id} ${what}`);
      if (row.review_policy !== policy) bad("policy label wrong");
      if ((row.review_instruction_sha256 ?? null) !== wantSha[policy]) bad("instruction hash wrong");
      if (typeof row.replay_correct !== "boolean") bad("verdict not boolean");
      if (row.error !== null) bad("has error");
      if (!text(row.draft_answer)) bad("draft empty");
      if (!text(row.evidence?.text)) bad("evidence empty");
      if (typeof row.review_prompt_sha256 !== "string" || !HEX64.test(row.review_prompt_sha256)) bad("prompt hash invalid");
      if (typeof row.is_abstention !== "boolean" || typeof row.baseline_correct !== "boolean") bad("baseline fields invalid");
    }
  }
  for (const id of expectedIds) {
    const a = maps.original.get(id), b = maps.scope.get(id);
    if (!a || !b) continue;
    if (a.draft_answer !== b.draft_answer || a.evidence?.text !== b.evidence?.text) problems.push(`${id} draft or evidence differs`);
    if (a.is_abstention !== b.is_abstention || a.baseline_correct !== b.baseline_correct) problems.push(`${id} baseline differs`);
    if (a.review_prompt_sha256 === b.review_prompt_sha256) problems.push(`${id} prompts not distinct`);
  }
  const ok = (row: PairRow | undefined) => row?.replay_correct === true && row.error === null;
  const abstention = (id: string) => (maps.original.get(id) ?? maps.scope.get(id))?.is_abstention === true;
  const gains = expectedIds.filter((id) => !ok(maps.original.get(id)) && ok(maps.scope.get(id)));
  const losses = expectedIds.filter((id) => ok(maps.original.get(id)) && !ok(maps.scope.get(id)));
  const withError = (map: Map<string, PairRow>) => [...map.values()].filter((row) => row.error !== null).map((row) => row.question_id);
  const control_correct = expectedIds.filter((id) => ok(maps.original.get(id))).length;
  const scope_correct = expectedIds.filter((id) => ok(maps.scope.get(id))).length;
  return {
    paired_valid: problems.length === 0, problems, expected: expectedIds.length, control_correct, scope_correct,
    gains, losses, net: gains.length - losses.length, abstention_losses: losses.filter(abstention),
    control_errors: withError(maps.original), scope_errors: withError(maps.scope),
  };
}
