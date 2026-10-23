/** Pure masking and validation for the locked LongMemEval grounding review. */
import { answerGenerationClock } from "./longmemeval-answer-review.js";
import { sha256, type Case } from "./longmemeval-qa-support.js";
import type { ContextReplayInput } from "./longmemeval-context-replay-input.js";

type Arm = "control" | "comparison";
type Selection = { selected_review_ids: string[]; development_ids: string[]; mask_seed: string | number };
type Result = { question_id: string; arm: Arm; answer: string | null; correct?: unknown; [key: string]: unknown };
type Completed = { status: string; comparison_valid: boolean; execution_mode: string; results: Result[] };
export type GroundingAnswer = { label: "A" | "B"; answer: string | null; generated: boolean };
export type GroundingPacket = { reviews: Array<{ review_id: string; question: string; clock: string; context: string; context_sha256: string; answers: [GroundingAnswer, GroundingAnswer] }> };
export type PrivateArmMap = { packet_canonical_sha256: string; reviews: Array<{ review_id: string; question_id: string; labels: Record<"A" | "B", Arm> }> };
export type GroundingPreReviewCommitment = { phase: "packet_prepared"; packet_canonical_sha256: string; private_map_canonical_sha256: string; pretrial_map_commitment_raw_sha256: string; map_core_canonical_sha256: string };
export type GroundingRatingsLock = { phase: "ratings_locked"; commitment_raw_sha256: string; ratings_raw_sha256: string; packet_canonical_sha256: string; private_map_canonical_sha256: string };
type Label = "supported" | "supported-inference" | "unsupported" | "contradicted" | "unresolved";
type Anchor = { quote: string; start: number; end: number };
type Claim = { proposition_id: string; proposition: string; label: Label; answer_quote?: string; answer_start?: number; answer_end?: number; answer_spans: Anchor[]; context_anchors?: Anchor[]; premises?: string[]; explanation?: string };
export type GroundingRating = { review_id: string; label: "A" | "B"; status: "rated" | "no_answer"; claims: Claim[]; segmentation_complete: boolean; segmentation_uncertain: boolean };

export const canonicalGroundingJson = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonicalGroundingJson).join(",")}]`
  : value && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalGroundingJson(item)}`).join(",")}}`
  : JSON.stringify(value) ?? "null";
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const range = (text: string, quote: unknown, start: unknown, end: unknown) =>
  typeof quote === "string" && quote.trim().length > 0 && typeof start === "number" && typeof end === "number"
  && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start < end && end <= text.length && text.slice(start, end) === quote;
const order = (seed: string | number, id: string) => sha256(`${seed}|case-order|${id}`);
const isLabel = (value: unknown): value is Label => ["supported", "supported-inference", "unsupported", "contradicted", "unresolved"].includes(value as string);
export const privateArmMapCore = (map: PrivateArmMap) => ({ reviews: map.reviews });

export function buildGroundingPackets(input: ContextReplayInput, completedReport: Completed, selection: Selection): { packet: GroundingPacket; private_arm_map: PrivateArmMap } {
  if (completedReport.status !== "complete" || completedReport.comparison_valid !== true || completedReport.execution_mode !== "native") throw new Error("Completed native comparison report required");
  if (!Array.isArray(selection.selected_review_ids) || selection.selected_review_ids.length !== 17 || new Set(selection.selected_review_ids).size !== 17) throw new Error("Invalid grounding selection");
  if (!Array.isArray(selection.development_ids) || selection.development_ids.length !== 60 || selection.development_ids.some((id, index) => id !== input.selected_question_ids[index])) throw new Error("Grounding development identity mismatch");
  const cases = new Map(input.cases.map((item) => [item.question_id, item]));
  if (selection.selected_review_ids.some((id) => !cases.has(id))) throw new Error("Grounding selection references unknown question");
  const rows = new Map<string, Map<Arm, Result>>();
  for (const row of completedReport.results) {
    if (!cases.has(row.question_id) || (row.arm !== "control" && row.arm !== "comparison")) throw new Error("Invalid inference result identity");
    const arms = rows.get(row.question_id) ?? new Map<Arm, Result>();
    if (arms.has(row.arm)) throw new Error("Duplicate inference arm result");
    arms.set(row.arm, row); rows.set(row.question_id, arms);
  }
  if (completedReport.results.length !== 120 || rows.size !== 60 || input.cases.some((item) => rows.get(item.question_id)?.size !== 2)) throw new Error("Complete 120-row paired inference report required");
  const selected = [...selection.selected_review_ids].sort((a, b) => order(selection.mask_seed, a).localeCompare(order(selection.mask_seed, b)));
  const reviews = selected.map((question_id, index) => {
    const item = cases.get(question_id)!, arms = rows.get(question_id);
    if (!arms || arms.size !== 2) throw new Error("Incomplete selected inference arms");
    const control = arms.get("control")!, comparison = arms.get("comparison")!;
    if (!("answer" in control) || !("answer" in comparison)) throw new Error("Missing final answer field");
    const aControl = (parseInt(sha256(`${selection.mask_seed}|arm-order|${question_id}`).slice(0, 2), 16) & 1) === 0;
    const answer = (arm: Arm): GroundingAnswer => {
      const value = arms.get(arm)!.answer;
      if (value !== null && (typeof value !== "string" || !value.trim())) throw new Error("Invalid final answer");
      return { label: arm === (aControl ? "control" : "comparison") ? "A" : "B", answer: value as string | null, generated: typeof value === "string" };
    };
    return {
      review_id: `review-${String(index + 1).padStart(3, "0")}`, question: item.generation.question,
      clock: answerGenerationClock(item.generation.answer_prompt_prefix), context: item.sides.recall.context,
      context_sha256: item.sides.recall.context_sha256, answers: [answer("control"), answer("comparison")].sort((a, b) => a.label.localeCompare(b.label)) as [GroundingAnswer, GroundingAnswer],
    };
  });
  const packet: GroundingPacket = { reviews };
  const mapReviews = reviews.map((review, index) => {
    const id = selected[index]!, aControl = (parseInt(sha256(`${selection.mask_seed}|arm-order|${id}`).slice(0, 2), 16) & 1) === 0;
    return { review_id: review.review_id, question_id: id, labels: { A: aControl ? "control" as const : "comparison" as const, B: aControl ? "comparison" as const : "control" as const } };
  });
  const private_arm_map: PrivateArmMap = {
    packet_canonical_sha256: sha256(canonicalGroundingJson(packet)),
    reviews: mapReviews,
  };
  return { packet, private_arm_map };
}

export function validateGroundingRatings(packet: GroundingPacket, ratingsInput: unknown) {
  const ratings = Array.isArray(ratingsInput) ? ratingsInput : isRecord(ratingsInput) && Array.isArray(ratingsInput.ratings) ? ratingsInput.ratings : null;
  if (!ratings || ratings.length !== 34) throw new Error("Expected exactly 34 grounding ratings");
  const expected = new Map(packet.reviews.flatMap((review) => review.answers.map((answer) => [`${review.review_id}|${answer.label}`, { review, answer }])));
  const seen = new Set<string>();
  const responses = ratings.map((value) => {
    if (!isRecord(value) || (value.label !== "A" && value.label !== "B") || typeof value.review_id !== "string" || (value.status !== "rated" && value.status !== "no_answer") || !Array.isArray(value.claims) || typeof value.segmentation_complete !== "boolean" || typeof value.segmentation_uncertain !== "boolean") throw new Error("Invalid grounding rating shape");
    const key = `${value.review_id}|${value.label}`, target = expected.get(key);
    if (!target || seen.has(key)) throw new Error("Duplicate or unknown grounding rating");
    seen.add(key);
    if (!target.answer.generated) {
      if (value.status !== "no_answer" || value.claims.length) throw new Error("Missing answer must be marked no_answer without claims");
      return { review_id: value.review_id, label: value.label, bad_union: 0, affected: false, unresolved: 0, coverage: 0, segmentation_complete: value.segmentation_complete, segmentation_uncertain: value.segmentation_uncertain };
    }
    if (value.status !== "rated") throw new Error("Generated answer must be rated");
    if (!value.claims.length && !(value.no_assertions === true && typeof value.reviewer_explanation === "string" && value.reviewer_explanation.trim())) throw new Error("Rated answer requires claims or a non-assertive explanation");
    const propositions = new Set<string>(), normalizedPropositions = new Set<string>(); let bad = 0, unresolved = 0;
    for (const claimValue of value.claims) {
      if (!isRecord(claimValue) || typeof claimValue.proposition_id !== "string" || !claimValue.proposition_id.trim() || propositions.has(claimValue.proposition_id) || typeof claimValue.proposition !== "string" || !claimValue.proposition.trim() || !isLabel(claimValue.label) || !Array.isArray(claimValue.answer_spans) || !claimValue.answer_spans.length || !claimValue.answer_spans.every((span) => isRecord(span) && range(target.answer.answer!, span.quote, span.start, span.end))) throw new Error("Invalid grounding claim");
      propositions.add(claimValue.proposition_id);
      const normalized = claimValue.proposition.trim().replace(/\s+/g, " ").toLowerCase();
      if (normalizedPropositions.has(normalized)) throw new Error("Duplicate normalized proposition");
      normalizedPropositions.add(normalized);
      const anchors = claimValue.context_anchors;
      if (anchors !== undefined && (!Array.isArray(anchors) || !anchors.every((anchor) => isRecord(anchor) && range(target.review.context, anchor.quote, anchor.start, anchor.end)))) throw new Error("Invalid grounding context anchor");
      const validAnchors = Array.isArray(anchors) && anchors.length > 0;
      if ((claimValue.label === "supported" || claimValue.label === "supported-inference" || claimValue.label === "contradicted") && (!validAnchors || !anchors.length)) throw new Error("Grounding claim requires exact context anchor");
      if (claimValue.label === "supported-inference" && (!Array.isArray(claimValue.premises) || !claimValue.premises.length || !claimValue.premises.every((premise) => typeof premise === "string" && premise.trim()) || typeof claimValue.explanation !== "string" || !claimValue.explanation.trim())) throw new Error("Supported inference requires premises and explanation");
      if (claimValue.label === "unsupported" || claimValue.label === "contradicted") bad++;
      if (claimValue.label === "unresolved") unresolved++;
    }
    return { review_id: value.review_id, label: value.label, bad_union: bad, affected: bad > 0, unresolved, coverage: 1, segmentation_complete: value.segmentation_complete, segmentation_uncertain: value.segmentation_uncertain };
  });
  if (seen.size !== expected.size) throw new Error("Missing grounding rating");
  return { responses, total_bad_union: responses.reduce((sum, row) => sum + row.bad_union, 0), total_unresolved: responses.reduce((sum, row) => sum + row.unresolved, 0), segmentation_flags: responses.filter((row) => row.segmentation_uncertain).length };
}

export function aggregateLockedGrounding(packet: GroundingPacket, ratingsBytes: string | Buffer, privateMap: PrivateArmMap, lockRecord: GroundingRatingsLock, preReviewCommitmentBytes: string | Buffer, expectedCommitmentSHA: string) {
  const commitmentRaw = typeof preReviewCommitmentBytes === "string" ? Buffer.from(preReviewCommitmentBytes) : preReviewCommitmentBytes;
  if (sha256(commitmentRaw) !== expectedCommitmentSHA) throw new Error("Pre-review commitment hash mismatch");
  let commitment: unknown; try { commitment = JSON.parse(commitmentRaw.toString()); } catch { throw new Error("Pre-review commitment JSON invalid"); }
  if (!isRecord(commitment) || commitment.phase !== "packet_prepared" || typeof commitment.packet_canonical_sha256 !== "string" || typeof commitment.private_map_canonical_sha256 !== "string" || typeof commitment.pretrial_map_commitment_raw_sha256 !== "string" || typeof commitment.map_core_canonical_sha256 !== "string") throw new Error("Invalid pre-review commitment");
  const raw = typeof ratingsBytes === "string" ? Buffer.from(ratingsBytes) : ratingsBytes;
  if (!isRecord(lockRecord) || lockRecord.phase !== "ratings_locked" || lockRecord.commitment_raw_sha256 !== expectedCommitmentSHA || lockRecord.ratings_raw_sha256 !== sha256(raw) || lockRecord.packet_canonical_sha256 !== commitment.packet_canonical_sha256 || lockRecord.private_map_canonical_sha256 !== commitment.private_map_canonical_sha256) throw new Error("Invalid ratings lock");
  if (sha256(canonicalGroundingJson(packet)) !== commitment.packet_canonical_sha256) throw new Error("Committed packet hash mismatch");
  if (sha256(canonicalGroundingJson(privateMap)) !== commitment.private_map_canonical_sha256) throw new Error("Committed private map hash mismatch");
  if (sha256(canonicalGroundingJson(privateArmMapCore(privateMap))) !== commitment.map_core_canonical_sha256) throw new Error("Committed private map core hash mismatch");
  let parsed: unknown; try { parsed = JSON.parse(raw.toString()); } catch { throw new Error("Locked ratings JSON invalid"); }
  const validated = validateGroundingRatings(packet, parsed);
  const reviewIds = new Set(packet.reviews.map((review) => review.review_id));
  if (privateMap.reviews.length !== 17 || new Set(privateMap.reviews.map((row) => row.review_id)).size !== 17 || privateMap.reviews.some((row) => !reviewIds.has(row.review_id) || row.labels.A === row.labels.B || !["control", "comparison"].includes(row.labels.A) || !["control", "comparison"].includes(row.labels.B))) throw new Error("Invalid private arm map");
  const mapping = new Map(privateMap.reviews.flatMap((row) => [["" + row.review_id + "|A", row.labels.A], ["" + row.review_id + "|B", row.labels.B]] as const));
  if (mapping.size !== 34 || [...mapping.values()].some((arm) => arm !== "control" && arm !== "comparison")) throw new Error("Invalid private arm assignments");
  const totals = { control: { badclaims: 0, badanswers: 0, finalcoverage: 0, unresolved: 0 }, comparison: { badclaims: 0, badanswers: 0, finalcoverage: 0, unresolved: 0 } };
  for (const response of validated.responses) {
    const arm = mapping.get(`${response.review_id}|${response.label}`);
    if (!arm) throw new Error("Rating/map mismatch");
    totals[arm].badclaims += response.bad_union; totals[arm].badanswers += Number(response.affected); totals[arm].finalcoverage += response.coverage; totals[arm].unresolved += response.unresolved;
  }
  const segmentation_incomplete = validated.responses.filter((row) => !row.segmentation_complete).length;
  const gatepass = totals.comparison.badclaims <= totals.control.badclaims && totals.comparison.badanswers <= totals.control.badanswers && totals.comparison.finalcoverage >= totals.control.finalcoverage && validated.total_unresolved === 0 && validated.segmentation_flags === 0 && segmentation_incomplete === 0;
  return { per_arm: totals, total_unresolved: validated.total_unresolved, segmentation_flags: validated.segmentation_flags, segmentation_incomplete, gatepass };
}
