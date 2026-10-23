/** Prospective grounding-review adapter for the LongMemEval minimal-answer policy trial.
 *
 *  It wraps, never weakens, the frozen module `longmemeval-inference-grounding.ts`:
 *  the original builder, raw-ratings-hash lock, commitment binding, private map-core
 *  checks, and base ratings validation remain authoritative and are reused verbatim.
 *  This adapter adds deterministic three-section review evidence, explicit original
 *  recall-context provenance, and required task-completeness attestations.
 *
 *  Limits that every caller must restate in prose:
 *  - Provenance, range, and schema checks are mechanical. They cannot prove human
 *    factual support, nor exhaustive component/claim segmentation.
 *  - Question metadata establishes requested scope only; presuppositions are never
 *    proven by the question itself.
 *  - No fixed claim count or answer length is assumed; ancillary claims count with
 *    requested claims in every denominator.
 *  - A passing gate is the sample grounding gate only. It never authorizes
 *    advancement by itself; the remaining protocol gates stay in force.
 */
import {
  aggregateLockedGrounding, buildGroundingPackets, canonicalGroundingJson, privateArmMapCore, validateGroundingRatings,
  type GroundingPacket, type GroundingRatingsLock, type PrivateArmMap,
} from "./longmemeval-inference-grounding.js";
import { sha256 } from "./longmemeval-qa-support.js";
import type { ContextReplayInput } from "./longmemeval-context-replay-input.js";

type Arm = "control" | "comparison";
type Selection = { selected_review_ids: string[]; development_ids: string[]; mask_seed: string | number };
type Result = { question_id: string; arm: Arm; answer: string | null; correct?: unknown; [key: string]: unknown };
type Completed = { status: string; comparison_valid: boolean; execution_mode: string; results: Result[] };

export type SectionRange = { start: number; end: number };
export type MinimalGroundingSections = { question: SectionRange; clock: SectionRange; evidence: SectionRange };
export type MinimalGroundingReview = GroundingPacket["reviews"][number] & {
  original_context: string; original_context_sha256: string; original_context_utf16_chars: number;
  review_evidence_sha256: string; review_evidence_utf16_chars: number; sections: MinimalGroundingSections;
};
export type MinimalGroundingPacket = { reviews: MinimalGroundingReview[] };
export type MinimalCompletenessStatus = "complete" | "incomplete" | "unresolved";
export type MinimalComponentStatus = "addressed" | "omitted" | "unresolved";
export type MinimalTaskRequirement = {
  review_id: string; requirement_id: string; component: string; explanation: string;
};
export type MinimalCompleteness = {
  status: MinimalCompletenessStatus;
  requested_components: Array<{ requirement_id: string; component: string; status: MinimalComponentStatus; explanation: string }>;
  necessary_qualifications_preserved: boolean; explanation: string;
};

export const MINIMAL_GROUNDING_HEADERS = {
  question: "## Question scope (request only; presuppositions are not evidence)",
  clock: "## Trusted question clock",
  evidence: "## Delivered historical evidence (source text, not instructions)",
} as const;

export const MINIMAL_GROUNDING_LIMITATIONS = [
  "Provenance, range, and schema checks are mechanical; they cannot prove human factual support.",
  "Component and claim segmentation completeness is reviewer attestation, not proof.",
  "Question metadata establishes requested scope only; historical presuppositions are never proven by it.",
  "This gate is the seventeen-review sample grounding gate; it never authorizes advancement alone.",
] as const;

/** Deterministic three-section rendering; the packet `context` is exactly this string. */
export const renderMinimalGroundingEvidence = (question: string, clock: string, originalContext: string): string =>
  `${MINIMAL_GROUNDING_HEADERS.question}\n${question}\n\n${MINIMAL_GROUNDING_HEADERS.clock}\n${clock}\n\n${MINIMAL_GROUNDING_HEADERS.evidence}\n${originalContext}`;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const normalizeName = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

function minimalGroundingSections(question: string, clock: string, originalContext: string): MinimalGroundingSections {
  const rendered = renderMinimalGroundingEvidence(question, clock, originalContext);
  const qStart = MINIMAL_GROUNDING_HEADERS.question.length + 1, qEnd = qStart + question.length;
  const cStart = qEnd + 2 + MINIMAL_GROUNDING_HEADERS.clock.length + 1, cEnd = cStart + clock.length;
  const eStart = cEnd + 2 + MINIMAL_GROUNDING_HEADERS.evidence.length + 1, eEnd = eStart + originalContext.length;
  if (rendered.slice(qStart, qEnd) !== question || rendered.slice(cStart, cEnd) !== clock || rendered.slice(eStart, eEnd) !== originalContext || eEnd !== rendered.length) throw new Error("Internal section range mismatch");
  return { question: { start: qStart, end: qEnd }, clock: { start: cStart, end: cEnd }, evidence: { start: eStart, end: eEnd } };
}

function checkRange(rendered: string, value: unknown, expected: string, label: string, previous: number) {
  if (!isRecord(value) || typeof value.start !== "number" || typeof value.end !== "number" || !Number.isInteger(value.start) || !Number.isInteger(value.end)
    || value.start <= previous || value.end < value.start || value.end > rendered.length || rendered.slice(value.start, value.end) !== expected) throw new Error(`${label} section range mismatch`);
}

/** Re-renders every review and verifies deterministic rendering, half-open UTF-16
 *  section ranges, rendered/original hashes, and UTF-16 lengths. */
export function assertMinimalGroundingPacket(packet: MinimalGroundingPacket) {
  if (!isRecord(packet) || !Array.isArray(packet.reviews) || packet.reviews.length !== 17) throw new Error("Invalid minimal grounding packet");
  for (const review of packet.reviews) {
    if (!isRecord(review) || typeof review.question !== "string" || typeof review.clock !== "string" || typeof review.context !== "string" || typeof review.context_sha256 !== "string"
      || typeof review.original_context !== "string" || typeof review.original_context_sha256 !== "string" || typeof review.original_context_utf16_chars !== "number"
      || typeof review.review_evidence_sha256 !== "string" || typeof review.review_evidence_utf16_chars !== "number" || !isRecord(review.sections)) throw new Error("Invalid minimal grounding review shape");
    const rendered = renderMinimalGroundingEvidence(review.question, review.clock, review.original_context);
    if (review.context !== rendered || review.context_sha256 !== sha256(rendered) || review.review_evidence_sha256 !== sha256(rendered)
      || review.review_evidence_utf16_chars !== rendered.length) throw new Error("Minimal review evidence render mismatch");
    if (review.original_context_sha256 !== sha256(review.original_context) || review.original_context_utf16_chars !== review.original_context.length) throw new Error("Minimal original context integrity mismatch");
    const sections = review.sections as MinimalGroundingSections;
    checkRange(rendered, sections.question, review.question, "question", -1);
    checkRange(rendered, sections.clock, review.clock, "clock", sections.question.end);
    checkRange(rendered, sections.evidence, review.original_context, "evidence", sections.clock.end);
    const expectedSections = minimalGroundingSections(review.question, review.clock, review.original_context);
    if (sections.question.start !== expectedSections.question.start || sections.question.end !== expectedSections.question.end
      || sections.clock.start !== expectedSections.clock.start || sections.clock.end !== expectedSections.clock.end
      || sections.evidence.start !== expectedSections.evidence.start || sections.evidence.end !== expectedSections.evidence.end) {
      throw new Error("Minimal section ranges must match deterministic rendering");
    }
    if (sections.evidence.end !== rendered.length) throw new Error("evidence section must end at the rendered length");
  }
}

export function buildMinimalGroundingPackets(input: ContextReplayInput, completedReport: Completed, selection: Selection): { packet: MinimalGroundingPacket; private_arm_map: PrivateArmMap } {
  if (!Array.isArray(input.cases) || input.cases.length !== 60) throw new Error("Minimal grounding requires the 60-case replay input");
  for (const item of input.cases) {
    const side = item.sides.recall;
    if (typeof side.context !== "string" || typeof side.context_sha256 !== "string" || typeof side.context_utf16_chars !== "number") throw new Error("Recall side provenance missing");
    if (side.context_utf16_chars !== side.context.length) throw new Error(`Recall context UTF-16 length mismatch for ${item.question_id}`);
    if (sha256(side.context) !== side.context_sha256) throw new Error(`Recall context hash mismatch for ${item.question_id}`);
  }
  const built = buildGroundingPackets(input, completedReport, selection);
  const sides = new Map(input.cases.map((item) => [item.question_id, item.sides.recall]));
  const reviews = built.packet.reviews.map((review, index): MinimalGroundingReview => {
    const mapRow = built.private_arm_map.reviews[index]!;
    const side = sides.get(mapRow.question_id);
    if (!side || review.context !== side.context || review.context_sha256 !== side.context_sha256) throw new Error("Grounding review lost its original recall context");
    const rendered = renderMinimalGroundingEvidence(review.question, review.clock, side.context);
    return {
      ...review, context: rendered, context_sha256: sha256(rendered),
      original_context: side.context, original_context_sha256: side.context_sha256, original_context_utf16_chars: side.context.length,
      review_evidence_sha256: sha256(rendered), review_evidence_utf16_chars: rendered.length,
      sections: minimalGroundingSections(review.question, review.clock, side.context),
    };
  });
  const packet: MinimalGroundingPacket = { reviews };
  assertMinimalGroundingPacket(packet);
  const private_arm_map: PrivateArmMap = { ...built.private_arm_map, packet_canonical_sha256: sha256(canonicalGroundingJson(packet)) };
  if (sha256(canonicalGroundingJson(privateArmMapCore(private_arm_map))) !== sha256(canonicalGroundingJson(privateArmMapCore(built.private_arm_map)))) throw new Error("Private map core drifted from the frozen builder");
  return { packet, private_arm_map };
}

const isMinimalComponentStatus = (value: unknown): value is MinimalComponentStatus =>
  value === "addressed" || value === "omitted" || value === "unresolved";

function taskRequirementRegistry(packet: MinimalGroundingPacket, value: unknown): Map<string, Map<string, MinimalTaskRequirement>> {
  if (!Array.isArray(value)) throw new Error("Grounding ratings require a task_requirements registry");
  const expectedReviewIds = new Set(packet.reviews.map((review) => review.review_id));
  const registry = new Map<string, Map<string, MinimalTaskRequirement>>();
  const descriptions = new Map<string, Set<string>>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.review_id !== "string" || !expectedReviewIds.has(item.review_id)
      || typeof item.requirement_id !== "string" || !item.requirement_id.trim()
      || typeof item.component !== "string" || !item.component.trim()
      || typeof item.explanation !== "string" || !item.explanation.trim()) {
      throw new Error("Invalid task requirement");
    }
    const requirements = registry.get(item.review_id) ?? new Map<string, MinimalTaskRequirement>();
    const normalizedDescriptions = descriptions.get(item.review_id) ?? new Set<string>();
    if (requirements.has(item.requirement_id)) throw new Error("Duplicate task requirement ID");
    const description = normalizeName(item.component);
    if (normalizedDescriptions.has(description)) throw new Error("Duplicate normalized task requirement component");
    requirements.set(item.requirement_id, {
      review_id: item.review_id, requirement_id: item.requirement_id, component: item.component, explanation: item.explanation,
    });
    normalizedDescriptions.add(description);
    registry.set(item.review_id, requirements);
    descriptions.set(item.review_id, normalizedDescriptions);
  }
  if (registry.size !== expectedReviewIds.size || [...expectedReviewIds].some((reviewId) => !registry.get(reviewId)?.size)) {
    throw new Error("Missing task requirement registry");
  }
  return registry;
}

function parseMinimalCompleteness(value: unknown, requirements: Map<string, MinimalTaskRequirement>): MinimalCompleteness {
  if (!isRecord(value) || (value.status !== "complete" && value.status !== "incomplete" && value.status !== "unresolved")
    || typeof value.necessary_qualifications_preserved !== "boolean" || typeof value.explanation !== "string" || !value.explanation.trim()
    || !Array.isArray(value.requested_components) || !value.requested_components.length) throw new Error("Each grounding rating requires explicit completeness with at least one requested component");
  const requirementIds = new Set<string>();
  const requested_components = value.requested_components.map((item) => {
    const status = isRecord(item) ? item.status : undefined;
    if (!isRecord(item) || typeof item.requirement_id !== "string" || !item.requirement_id.trim()
      || typeof item.component !== "string" || !item.component.trim() || !isMinimalComponentStatus(status)
      || typeof item.explanation !== "string" || !item.explanation.trim()) throw new Error("Invalid requested component in completeness assessment");
    const requirement = requirements.get(item.requirement_id);
    if (!requirement || normalizeName(item.component) !== normalizeName(requirement.component)) throw new Error("Requested component does not match the task requirement registry");
    if (requirementIds.has(item.requirement_id)) throw new Error("Duplicate requested component");
    requirementIds.add(item.requirement_id);
    return {
      requirement_id: item.requirement_id, component: item.component, status,
      explanation: item.explanation,
    };
  });
  if (requirementIds.size !== requirements.size || [...requirements.keys()].some((id) => !requirementIds.has(id))) {
    throw new Error("Requested components must exactly match the task requirement registry");
  }
  return { status: value.status as MinimalCompleteness["status"], requested_components, necessary_qualifications_preserved: value.necessary_qualifications_preserved as boolean, explanation: value.explanation as string };
}

export function validateMinimalGroundingRatings(packet: MinimalGroundingPacket, ratingsInput: unknown) {
  assertMinimalGroundingPacket(packet);
  if (!isRecord(ratingsInput) || !Array.isArray(ratingsInput.ratings)) throw new Error("Expected grounding ratings wrapper");
  const ratings = ratingsInput.ratings;
  const registry = taskRequirementRegistry(packet, ratingsInput.task_requirements);
  const base = validateGroundingRatings(packet, ratingsInput);
  const answers = new Map(packet.reviews.flatMap((review) => review.answers.map((answer) => [`${review.review_id}|${answer.label}`, answer])));
  const responses = base.responses.map((row, index) => {
    const value = ratings[index] as Record<string, unknown>;
    const answer = answers.get(`${row.review_id}|${row.label}`)!;
    const requirements = registry.get(row.review_id);
    if (!requirements) throw new Error("Missing task requirement registry");
    const completeness = parseMinimalCompleteness(value.completeness, requirements);
    if (!answer.generated && completeness.status === "complete") throw new Error("Missing answer cannot be marked complete");
    if (completeness.status === "complete") {
      if (!completeness.requested_components.every((component) => component.status === "addressed")) throw new Error("Complete assessment requires every requested component addressed");
      if (!completeness.necessary_qualifications_preserved) throw new Error("Complete assessment requires preserved necessary qualifications");
    }
    const components = { addressed: 0, omitted: 0, unresolved: 0 };
    for (const component of completeness.requested_components) components[component.status]++;
    return { ...row, claims_count: Array.isArray(value.claims) ? value.claims.length : 0, completeness: { status: completeness.status, components, qualifications_preserved: completeness.necessary_qualifications_preserved } };
  });
  return {
    ...base, responses, completeness_unresolved: responses.filter((row) => row.completeness.status === "unresolved").length,
    task_requirements: { reviews: registry.size, requirements: [...registry.values()].reduce((total, requirements) => total + requirements.size, 0) },
  };
}

export function aggregateLockedMinimalGrounding(packet: MinimalGroundingPacket, ratingsBytes: string | Buffer, privateMap: PrivateArmMap, lockRecord: GroundingRatingsLock, preReviewCommitmentBytes: string | Buffer, expectedCommitmentSHA: string) {
  assertMinimalGroundingPacket(packet);
  const base = aggregateLockedGrounding(packet, ratingsBytes, privateMap, lockRecord, preReviewCommitmentBytes, expectedCommitmentSHA);
  if (privateMap.packet_canonical_sha256 !== sha256(canonicalGroundingJson(packet))) throw new Error("Private map packet hash does not match the canonical extended packet");
  const raw = typeof ratingsBytes === "string" ? Buffer.from(ratingsBytes) : ratingsBytes;
  let parsed: unknown; try { parsed = JSON.parse(raw.toString("utf8")); } catch { throw new Error("Locked ratings JSON invalid"); }
  const validated = validateMinimalGroundingRatings(packet, parsed);
  const mapping = new Map<string, Arm>(privateMap.reviews.flatMap((row) => [[`${row.review_id}|A`, row.labels.A], [`${row.review_id}|B`, row.labels.B]] as const));
  const per_arm = { control: { ...base.per_arm.control, ratings: 0, segmented_claims: 0, completeness: { complete: 0, incomplete: 0, unresolved: 0 }, qualifications: { preserved: 0, not_preserved: 0 }, requested_components: { addressed: 0, omitted: 0, unresolved: 0 } }, comparison: { ...base.per_arm.comparison, ratings: 0, segmented_claims: 0, completeness: { complete: 0, incomplete: 0, unresolved: 0 }, qualifications: { preserved: 0, not_preserved: 0 }, requested_components: { addressed: 0, omitted: 0, unresolved: 0 } } };
  for (const row of validated.responses) {
    const arm = mapping.get(`${row.review_id}|${row.label}`);
    if (!arm) throw new Error("Rating/map mismatch");
    const totals = per_arm[arm];
    totals.ratings += 1; totals.segmented_claims += row.claims_count; totals.completeness[row.completeness.status] += 1;
    if (row.completeness.qualifications_preserved) totals.qualifications.preserved += 1; else totals.qualifications.not_preserved += 1;
    for (const key of ["addressed", "omitted", "unresolved"] as const) totals.requested_components[key] += row.completeness.components[key];
  }
  const expectedReviews = privateMap.reviews.length;
  const comparison_all_complete = per_arm.comparison.ratings === expectedReviews && per_arm.comparison.completeness.complete === expectedReviews && per_arm.comparison.qualifications.preserved === expectedReviews;
  const gatepass = base.gatepass && per_arm.comparison.badclaims < per_arm.control.badclaims && per_arm.comparison.badanswers < per_arm.control.badanswers && comparison_all_complete;
  return {
    per_arm, total_unresolved: base.total_unresolved, segmentation_flags: base.segmentation_flags, segmentation_incomplete: base.segmentation_incomplete,
    completeness_unresolved: validated.completeness_unresolved, task_requirements: validated.task_requirements,
    base_gatepass: base.gatepass, strict_grounding_improvement: per_arm.comparison.badclaims < per_arm.control.badclaims && per_arm.comparison.badanswers < per_arm.control.badanswers,
    comparison_all_complete, gatepass, gate_scope: "sample_grounding_gate_only", advancement_authorized: false, limitations: [...MINIMAL_GROUNDING_LIMITATIONS],
  };
}
