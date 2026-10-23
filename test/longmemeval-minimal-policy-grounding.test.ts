import { describe, expect, it } from "vitest";
import { sha256 } from "../benchmark/longmemeval-qa-support.js";
import { buildGroundingPackets, canonicalGroundingJson, privateArmMapCore } from "../benchmark/longmemeval-inference-grounding.js";
import {
  aggregateLockedMinimalGrounding, buildMinimalGroundingPackets, renderMinimalGroundingEvidence, validateMinimalGroundingRatings,
  MINIMAL_GROUNDING_HEADERS, type MinimalGroundingPacket,
} from "../benchmark/longmemeval-minimal-policy-grounding.js";
import type { ContextReplayInput } from "../benchmark/longmemeval-context-replay-input.js";

type Row = Record<string, any>;

function fixture() {
  const cases = Array.from({ length: 60 }, (_, index) => {
    const id = `q${String(index).padStart(2, "0")}`, context = `source 😀 fact ${index}`;
    return {
      index, question_id: id, question_type: `type-${Math.floor(index / 10)}`, is_abstention: false,
      generation: { question: `Question ${index}?`, answer_prompt_prefix: `Task\nQuestion: Question ${index}?\nQuestion Date: 2026-01-01\n\nRetrieved Context:\n__RECALL_CONTEXT__` },
      judge_case: { question_id: id, question: `Question ${index}?`, question_type: `type-${Math.floor(index / 10)}`, is_abstention: false, question_date: "2026", reference: "SECRET_REFERENCE", gold_session_ids: ["GOLD"], answer_prompt_prefix: "x __RECALL_CONTEXT__", judge_prompt_template: "x __RECALL_CANDIDATE__", sessions: [] },
      sides: { recall: { name: "recall" as const, context, context_sha256: sha256(context), context_utf16_chars: context.length, replacements: [] }, hindsight: { name: "hindsight" as const, context: "unused", context_sha256: sha256("unused"), context_utf16_chars: 6, replacements: [] } },
    };
  });
  const input: ContextReplayInput = { selected_question_ids: cases.map((item) => item.question_id), cases, source_canonical_sha256: {}, generation_blinding: "fixture" };
  const selection = { development_ids: input.selected_question_ids, selected_review_ids: input.selected_question_ids.slice(0, 17), mask_seed: 20261024 };
  const report = { status: "complete", comparison_valid: true, execution_mode: "native", results: input.cases.flatMap((item) => [{ question_id: item.question_id, arm: "control" as const, answer: item.index === 0 ? null : `control-${item.index}`, correct: false, drafts: "SECRET_DRAFT" }, { question_id: item.question_id, arm: "comparison" as const, answer: `comparison-${item.index}`, correct: true, judge_reason: "SECRET_JUDGE" }]) };
  return { input, selection, report, built: buildMinimalGroundingPackets(input, report, selection) };
}

const completeBlock = (over: Row = {}) => ({
  status: "complete",
  requested_components: [{ requirement_id: "r1", component: "core answer", status: "addressed", explanation: "The answer addresses the asked part." }],
  necessary_qualifications_preserved: true,
  explanation: "Every requested component was addressed.",
  ...over,
});

function taskRequirements(packet: MinimalGroundingPacket): Row[] {
  return packet.reviews.map((review) => ({
    review_id: review.review_id,
    requirement_id: "r1",
    component: "core answer",
    explanation: "The answer must address the explicit request.",
  }));
}
const wrapper = (packet: MinimalGroundingPacket, rows: Row[], requirements = taskRequirements(packet)) => ({ ratings: rows, task_requirements: requirements });
const validate = (packet: MinimalGroundingPacket, rows: Row[], requirements?: Row[]) =>
  validateMinimalGroundingRatings(packet, wrapper(packet, rows, requirements));

function makeRatings(packet: MinimalGroundingPacket): Row[] {
  return packet.reviews.flatMap((review) => review.answers.map((answer) => answer.generated
    ? { review_id: review.review_id, label: answer.label, status: "rated", segmentation_complete: true, segmentation_uncertain: false, claims: [{ proposition_id: "p1", proposition: `fact ${review.review_id}`, label: "supported", answer_spans: [{ quote: answer.answer!.slice(0, 4), start: 0, end: 4 }], context_anchors: [{ quote: review.context.slice(0, 8), start: 0, end: 8 }] }], completeness: completeBlock() }
    : { review_id: review.review_id, label: answer.label, status: "no_answer", claims: [], segmentation_complete: true, segmentation_uncertain: false, completeness: completeBlock({ status: "incomplete", requested_components: [{ requirement_id: "r1", component: "core answer", status: "omitted", explanation: "No answer was generated." }], necessary_qualifications_preserved: false, explanation: "The answer is missing." }) }));
}

function locate(built: ReturnType<typeof fixture>["built"], question_id: string, arm: "control" | "comparison") {
  const row = built.private_arm_map.reviews.find((item) => item.question_id === question_id)!;
  return { review_id: row.review_id, label: row.labels.A === arm ? "A" as const : "B" as const };
}

function flow(built: ReturnType<typeof fixture>["built"], rows: Row[], requirements = taskRequirements(built.packet)) {
  const raw = JSON.stringify(wrapper(built.packet, rows, requirements));
  const commitment = { phase: "packet_prepared" as const, packet_canonical_sha256: sha256(canonicalGroundingJson(built.packet)), private_map_canonical_sha256: sha256(canonicalGroundingJson(built.private_arm_map)), pretrial_map_commitment_raw_sha256: "pretrial", map_core_canonical_sha256: sha256(canonicalGroundingJson(privateArmMapCore(built.private_arm_map))) };
  const commitmentBytes = JSON.stringify(commitment), hash = sha256(commitmentBytes);
  const lock = { phase: "ratings_locked" as const, commitment_raw_sha256: hash, ratings_raw_sha256: sha256(raw), packet_canonical_sha256: commitment.packet_canonical_sha256, private_map_canonical_sha256: commitment.private_map_canonical_sha256 };
  return { raw, hash, commitmentBytes, lock };
}
function agg(built: ReturnType<typeof fixture>["built"], rows: Row[], requirements?: Row[]) {
  const f = flow(built, rows, requirements);
  return aggregateLockedMinimalGrounding(built.packet, f.raw, built.private_arm_map, f.lock, f.commitmentBytes, f.hash);
}
function edit(rows: Row[], review_id: string, label: string) {
  const next = structuredClone(rows), row = next.find((item) => item.review_id === review_id && item.label === label)!;
  return { next, row };
}
const bad = (row: Row, labelValue: string) => { row.claims[0].label = labelValue; };

describe("LongMemEval minimal policy grounding adapter", () => {
  it("renders deterministic sections with verified original SHA, UTF-16 lengths, and ranges", () => {
    const { input, selection, report, built } = fixture();
    const reordered = buildMinimalGroundingPackets(input, { ...report, results: [...report.results].reverse() }, selection);
    expect(built.packet).toEqual(reordered.packet);
    expect(built.packet.reviews).toHaveLength(17);
    expect(built.packet.reviews.flatMap((review) => review.answers)).toHaveLength(34);
    for (const review of built.packet.reviews) {
      expect(review.context).toBe(renderMinimalGroundingEvidence(review.question, review.clock, review.original_context));
      expect(review.context.startsWith(`${MINIMAL_GROUNDING_HEADERS.question}\n${review.question}\n\n${MINIMAL_GROUNDING_HEADERS.clock}\n${review.clock}\n\n${MINIMAL_GROUNDING_HEADERS.evidence}\n`)).toBe(true);
      expect(review.clock).toBe("2026-01-01");
      expect(review.context_sha256).toBe(sha256(review.context));
      expect(review.review_evidence_sha256).toBe(sha256(review.context));
      expect(review.review_evidence_utf16_chars).toBe(review.context.length);
      expect(review.original_context_sha256).toBe(sha256(review.original_context));
      expect(review.original_context_utf16_chars).toBe(review.original_context.length);
      expect(review.original_context).toContain("😀");
      expect(review.context.slice(review.sections.question.start, review.sections.question.end)).toBe(review.question);
      expect(review.context.slice(review.sections.clock.start, review.sections.clock.end)).toBe(review.clock);
      expect(review.context.slice(review.sections.evidence.start, review.sections.evidence.end)).toBe(review.original_context);
      expect(review.sections.evidence.end).toBe(review.context.length);
    }
  });

  it("verifies every original recall context before the frozen builder and reuses its native row/selection checks", () => {
    const { input, selection, report, built } = fixture();
    const hashTampered = structuredClone({ ...input, cases: input.cases }); hashTampered.cases[3].sides.recall.context = "SOURCE 😀 fact 3";
    expect(() => buildMinimalGroundingPackets(hashTampered as ContextReplayInput, report, selection)).toThrow("Recall context hash mismatch");
    const lengthTampered = structuredClone({ ...input, cases: input.cases }); lengthTampered.cases[5].sides.recall.context_utf16_chars += 1;
    expect(() => buildMinimalGroundingPackets(lengthTampered as ContextReplayInput, report, selection)).toThrow("Recall context UTF-16 length mismatch");
    expect(() => buildMinimalGroundingPackets(input, { ...report, status: "partial" }, selection)).toThrow("Completed");
    expect(() => buildMinimalGroundingPackets(input, report, { ...selection, selected_review_ids: selection.selected_review_ids.slice(1) })).toThrow("Invalid grounding selection");
    expect(built.packet.reviews.length).toBe(17);
  });

  it("excludes references, drafts, outcomes and private ids while keeping the map core identical", () => {
    const { input, selection, report, built } = fixture();
    const visible = JSON.stringify(built.packet);
    for (const secret of ["SECRET_REFERENCE", "SECRET_DRAFT", "SECRET_JUDGE", '"q00"', '"correct"']) expect(visible).not.toContain(secret);
    const base = buildGroundingPackets(input, report, selection);
    expect(privateArmMapCore(built.private_arm_map)).toEqual(privateArmMapCore(base.private_arm_map));
    expect(built.private_arm_map.packet_canonical_sha256).toBe(sha256(canonicalGroundingJson(built.packet)));
    expect(built.private_arm_map.packet_canonical_sha256).not.toBe(sha256(canonicalGroundingJson(base.packet)));
  });

  it("verifies deterministic rendering, ranges and original integrity while validating ratings", () => {
    const { built } = fixture();
    const rows = makeRatings(built.packet);
    expect(validate(built.packet, rows).responses).toHaveLength(34);
    const contextTampered = structuredClone(built.packet); contextTampered.reviews[0]!.context = contextTampered.reviews[0]!.context.slice(4);
    expect(() => validate(contextTampered, rows)).toThrow("render mismatch");
    const rangeTampered = structuredClone(built.packet); rangeTampered.reviews[1]!.sections.question.end += 1;
    expect(() => validate(rangeTampered, rows)).toThrow("section range mismatch");
    const originalTampered = structuredClone(built.packet); originalTampered.reviews[2]!.original_context += " tamper";
    expect(() => validate(originalTampered, rows)).toThrow(/render mismatch|integrity mismatch/);
    const review = built.packet.reviews[0]!;
    const quote = review.context.slice(review.sections.evidence.start + 6, review.sections.evidence.start + 9);
    const { next, row } = edit(rows, review.review_id, "B");
    const anchor = { quote, start: review.sections.evidence.start + 6, end: review.sections.evidence.start + 9 };
    row.claims[0].context_anchors = [anchor];
    expect(validate(built.packet, next).responses).toHaveLength(34);
    const { next: shifted, row: shiftRow } = edit(next, review.review_id, "B");
    shiftRow.claims[0].context_anchors = [{ ...anchor, start: anchor.start + 1 }];
    expect(() => validate(built.packet, shifted)).toThrow("Invalid grounding context anchor");
  });

  it("rejects repeated question and clock substrings unless ranges are the deterministic offsets", () => {
    const { built } = fixture();
    const rows = makeRatings(built.packet);
    const alternate = structuredClone(built.packet);
    const review = alternate.reviews[0]!;
    review.question = "Question";
    review.clock = "Trusted";
    review.context = renderMinimalGroundingEvidence(review.question, review.clock, review.original_context);
    review.context_sha256 = sha256(review.context);
    review.review_evidence_sha256 = sha256(review.context);
    review.review_evidence_utf16_chars = review.context.length;
    const questionStart = MINIMAL_GROUNDING_HEADERS.question.length + 1;
    const clockStart = questionStart + review.question.length + 2 + MINIMAL_GROUNDING_HEADERS.clock.length + 1;
    const evidenceStart = clockStart + review.clock.length + 2 + MINIMAL_GROUNDING_HEADERS.evidence.length + 1;
    review.sections = {
      question: { start: MINIMAL_GROUNDING_HEADERS.question.indexOf("Question"), end: MINIMAL_GROUNDING_HEADERS.question.indexOf("Question") + review.question.length },
      clock: { start: review.context.indexOf("Trusted"), end: review.context.indexOf("Trusted") + review.clock.length },
      evidence: { start: evidenceStart, end: review.context.length },
    };
    expect(questionStart).toBeGreaterThan(review.sections.question.start);
    expect(clockStart).toBeGreaterThan(review.sections.clock.start);
    expect(() => validate(alternate, rows)).toThrow("Minimal section ranges must match deterministic rendering");
  });

  it("enforces explicit completeness and the shared requirement registry on every rating", () => {
    const { built } = fixture();
    const rows = makeRatings(built.packet);
    const expectThrows = (mutate: (row: Row) => void, target: { review_id: string; label: string }, message: RegExp) => {
      const { next, row } = edit(rows, target.review_id, target.label); mutate(row);
      expect(() => validate(built.packet, next)).toThrow(message);
    };
    expectThrows((row) => { delete row.completeness; }, locate(built, "q05", "control"), /completeness/);
    expectThrows((row) => { row.completeness.requested_components = []; }, locate(built, "q05", "control"), /at least one requested component/);
    expectThrows((row) => { row.completeness.requested_components.push({ requirement_id: "r1", component: "core answer", status: "addressed", explanation: "duplicate ID" }); }, locate(built, "q05", "control"), /Duplicate requested component/);
    expectThrows((row) => { row.completeness.requested_components = [{ requirement_id: "r1", component: "  ", status: "addressed", explanation: "blank" }]; }, locate(built, "q05", "control"), /Invalid requested component/);
    expectThrows((row) => { row.completeness.requested_components = [{ requirement_id: "r1", component: "core", status: "addressed", explanation: "" }]; }, locate(built, "q05", "control"), /Invalid requested component/);
    expectThrows((row) => { row.completeness = completeBlock(); }, locate(built, "q00", "control"), /Missing answer cannot be marked complete/);
    expectThrows((row) => { row.completeness.requested_components = [{ requirement_id: "r1", component: "core answer", status: "omitted", explanation: "left out" }]; }, locate(built, "q05", "control"), /every requested component addressed/);
    expectThrows((row) => { row.completeness.necessary_qualifications_preserved = false; }, locate(built, "q05", "control"), /preserved necessary qualifications/);
    const noAssertion = locate(built, "q06", "comparison");
    const { next: attested, row: attestedRow } = edit(rows, noAssertion.review_id, noAssertion.label);
    Object.assign(attestedRow, { claims: [], no_assertions: true, reviewer_explanation: "The answer asserts no facts." });
    expect(validate(built.packet, attested).responses).toHaveLength(34);
  });

  it("requires one complete shared registry for every review and both masked answers", () => {
    const { built } = fixture();
    const rows = makeRatings(built.packet);
    expect(validate(built.packet, rows).task_requirements).toEqual({ reviews: 17, requirements: 17 });
    expect(() => validateMinimalGroundingRatings(built.packet, rows)).toThrow("wrapper");
    const missingReview = taskRequirements(built.packet).slice(1);
    expect(() => validate(built.packet, rows, missingReview)).toThrow("Missing task requirement registry");
    const duplicateId = taskRequirements(built.packet);
    duplicateId.push({ ...duplicateId[0]! });
    expect(() => validate(built.packet, rows, duplicateId)).toThrow("Duplicate task requirement ID");
    const duplicateDescription = taskRequirements(built.packet);
    duplicateDescription.push({ ...duplicateDescription[0]!, requirement_id: "r2", component: " CORE   answer " });
    expect(() => validate(built.packet, rows, duplicateDescription)).toThrow("Duplicate normalized task requirement component");
    const unknownReview = taskRequirements(built.packet);
    unknownReview[0]!.review_id = "review-unknown";
    expect(() => validate(built.packet, rows, unknownReview)).toThrow("Invalid task requirement");
    const control = locate(built, "q05", "control");
    const { next: droppedControl, row: controlRow } = edit(rows, control.review_id, control.label);
    controlRow.completeness.requested_components = [];
    expect(() => validate(built.packet, droppedControl)).toThrow("at least one requested component");
    const comparison = locate(built, "q05", "comparison");
    const { next: droppedComparison, row: comparisonRow } = edit(rows, comparison.review_id, comparison.label);
    comparisonRow.completeness.requested_components = [];
    expect(() => validate(built.packet, droppedComparison)).toThrow("at least one requested component");
    const { next: mismatched, row: mismatchRow } = edit(rows, comparison.review_id, comparison.label);
    mismatchRow.completeness.requested_components[0].component = "a different task";
    expect(() => validate(built.packet, mismatched)).toThrow("does not match the task requirement registry");
    const { next: extra, row: extraRow } = edit(rows, comparison.review_id, comparison.label);
    extraRow.completeness.requested_components.push({ requirement_id: "r2", component: "new requirement", status: "addressed", explanation: "extra" });
    expect(() => validate(built.packet, extra)).toThrow("does not match the task requirement registry");
  });

  it("binds aggregation to the locked commitment, raw ratings hash, map hashes, and packet", () => {
    const { built } = fixture();
    const rows = makeRatings(built.packet), f = flow(built, rows);
    expect(() => aggregateLockedMinimalGrounding(built.packet, f.raw, built.private_arm_map, f.lock, f.commitmentBytes, "bad")).toThrow("commitment hash mismatch");
    expect(() => aggregateLockedMinimalGrounding(built.packet, `${f.raw} `, built.private_arm_map, f.lock, f.commitmentBytes, f.hash)).toThrow("ratings lock");
    const { raw, hash, commitmentBytes } = f;
    expect(() => aggregateLockedMinimalGrounding(built.packet, raw, built.private_arm_map, { ...f.lock, packet_canonical_sha256: "0".repeat(64) }, commitmentBytes, hash)).toThrow("ratings lock");
    expect(() => aggregateLockedMinimalGrounding(built.packet, raw, { ...built.private_arm_map, packet_canonical_sha256: "f".repeat(64) }, f.lock, commitmentBytes, hash)).toThrow("private map hash");
    const swappedMap = structuredClone(built.private_arm_map); [swappedMap.reviews[0]!.labels.A, swappedMap.reviews[0]!.labels.B] = [swappedMap.reviews[0]!.labels.B, swappedMap.reviews[0]!.labels.A];
    expect(() => aggregateLockedMinimalGrounding(built.packet, raw, swappedMap, f.lock, commitmentBytes, hash)).toThrow("private map hash");
    const tamperedPacket = structuredClone(built.packet); tamperedPacket.reviews[0]!.review_evidence_sha256 = "0".repeat(64);
    expect(() => aggregateLockedMinimalGrounding(tamperedPacket, raw, built.private_arm_map, f.lock, commitmentBytes, hash)).toThrow("render mismatch");
    const ok = aggregateLockedMinimalGrounding(built.packet, raw, built.private_arm_map, f.lock, commitmentBytes, hash);
    expect(ok.base_gatepass).toBe(true);
    expect(ok.gatepass).toBe(false); // equality is not a strict improvement
    expect(ok.per_arm.comparison.ratings).toBe(17);
    expect(ok.per_arm.comparison.completeness).toEqual({ complete: 17, incomplete: 0, unresolved: 0 });
    expect(ok.per_arm.control.completeness).toEqual({ complete: 16, incomplete: 1, unresolved: 0 });
    expect(ok.per_arm.control.requested_components).toEqual({ addressed: 16, omitted: 1, unresolved: 0 });
    expect(ok.per_arm.comparison.segmented_claims).toBe(17);
    expect(ok.task_requirements).toEqual({ reviews: 17, requirements: 17 });
    expect(ok.completeness_unresolved).toBe(0);
    expect(ok.gate_scope).toBe("sample_grounding_gate_only");
    expect(ok.advancement_authorized).toBe(false);
  });

  it("requires strictly fewer bad claims and bad answers, never equality or partial improvement", () => {
    const { built } = fixture();
    const rows = makeRatings(built.packet);
    expect(agg(built, rows).gatepass).toBe(false);
    const controlBad = locate(built, "q05", "control");
    const { next: improved, row: improvedRow } = edit(rows, controlBad.review_id, controlBad.label);
    bad(improvedRow, "contradicted");
    const better = agg(built, improved);
    expect(better.base_gatepass).toBe(true); expect(better.strict_grounding_improvement).toBe(true); expect(better.gatepass).toBe(true);
    expect(better.per_arm.control.badclaims).toBe(1); expect(better.per_arm.comparison.badclaims).toBe(0);
    const bothBad = locate(built, "q07", "comparison");
    const { next: equal, row: equalRow } = edit(improved, bothBad.review_id, bothBad.label);
    bad(equalRow, "unsupported");
    expect(agg(built, equal).gatepass).toBe(false); // equality must fail
    const { next: doubled, row: claimRow } = edit(improved, controlBad.review_id, controlBad.label);
    claimRow.claims.push({ proposition_id: "p2", proposition: "extra fact", label: "unsupported", answer_spans: claimRow.claims[0].answer_spans });
    const comparisonBad = locate(built, "q07", "comparison");
    const { next: fewerClaims, row: comparisonRow } = edit(doubled, comparisonBad.review_id, comparisonBad.label);
    bad(comparisonRow, "unsupported");
    const partial = agg(built, fewerClaims);
    expect(partial.per_arm.comparison.badclaims < partial.per_arm.control.badclaims).toBe(true);
    expect(partial.per_arm.control.badclaims).toBe(2);
    expect(partial.per_arm.control.badanswers).toBe(1);
    expect(partial.per_arm.comparison.badclaims).toBe(1);
    expect(partial.per_arm.comparison.badanswers).toBe(1);
    expect(partial.gatepass).toBe(false); // bad answers are equal, so improvement is not strict on both axes
    const firstControl = locate(built, "q05", "control");
    const secondControl = locate(built, "q06", "control");
    const oneComparison = locate(built, "q07", "comparison");
    const { next: equalClaims, row: firstControlRow } = edit(rows, firstControl.review_id, firstControl.label);
    bad(firstControlRow, "unsupported");
    const secondControlRow = equalClaims.find((row) => row.review_id === secondControl.review_id && row.label === secondControl.label)!;
    bad(secondControlRow, "unsupported");
    const comparisonRowWithTwoClaims = equalClaims.find((row) => row.review_id === oneComparison.review_id && row.label === oneComparison.label)!;
    bad(comparisonRowWithTwoClaims, "unsupported");
    comparisonRowWithTwoClaims.claims.push({ proposition_id: "p2", proposition: "another unsupported fact", label: "unsupported", answer_spans: comparisonRowWithTwoClaims.claims[0].answer_spans });
    const equalClaimsResult = agg(built, equalClaims);
    expect(equalClaimsResult.per_arm.control).toMatchObject({ badclaims: 2, badanswers: 2 });
    expect(equalClaimsResult.per_arm.comparison).toMatchObject({ badclaims: 2, badanswers: 1 });
    expect(equalClaimsResult.gatepass).toBe(false); // claims are not strictly fewer
  });

  it("blocks the gate on comparison omissions, unresolved claims, or segmentation problems in either arm", () => {
    const { built } = fixture();
    const controlBad = locate(built, "q05", "control");
    const { next: improved } = edit(makeRatings(built.packet), controlBad.review_id, controlBad.label);
    bad(improved.find((row) => row.review_id === controlBad.review_id && row.label === controlBad.label)!, "unsupported");
    expect(agg(built, improved).gatepass).toBe(true);
    const comparisonSoft = locate(built, "q11", "comparison");
    const { next: omitted, row: omitRow } = edit(improved, comparisonSoft.review_id, comparisonSoft.label);
    omitRow.completeness = completeBlock({ status: "incomplete", explanation: "An ancillary part was left out." });
    const soft = agg(built, omitted);
    expect(soft.base_gatepass).toBe(true); expect(soft.gatepass).toBe(false); // no advancement despite fewer bad claims: a comparison answer is incomplete
    const { next: completenessUnresolved, row: completenessRow } = edit(improved, comparisonSoft.review_id, comparisonSoft.label);
    completenessRow.completeness = completeBlock({ status: "unresolved", explanation: "The requested scope cannot be established." });
    const unresolvedCompleteness = agg(built, completenessUnresolved);
    expect(unresolvedCompleteness.base_gatepass).toBe(true);
    expect(unresolvedCompleteness.completeness_unresolved).toBe(1);
    expect(unresolvedCompleteness.gatepass).toBe(false);
    const { next: unresolvedComparison, row: unresolvedRow } = edit(improved, comparisonSoft.review_id, comparisonSoft.label);
    bad(unresolvedRow, "unresolved");
    const unresolved = agg(built, unresolvedComparison);
    expect(unresolved.base_gatepass).toBe(false); expect(unresolved.gatepass).toBe(false);
    const controlUnresolved = locate(built, "q12", "control");
    const { next: unresolvedControl, row: controlRow } = edit(improved, controlUnresolved.review_id, controlUnresolved.label);
    bad(controlRow, "unresolved");
    expect(agg(built, unresolvedControl).gatepass).toBe(false); // unresolved claims in either arm block
    const { next: uncertain, row: uncertainRow } = edit(improved, comparisonSoft.review_id, comparisonSoft.label);
    uncertainRow.segmentation_uncertain = true;
    expect(agg(built, uncertain).gatepass).toBe(false);
    const { next: incompleteSeg, row: segRow } = edit(improved, controlUnresolved.review_id, controlUnresolved.label);
    segRow.segmentation_complete = false;
    expect(agg(built, incompleteSeg).gatepass).toBe(false); // control uncertainty cannot be ignored
  });

  it("keeps negative findings counted and permits a complete non-assertive answer only with complete attestation", () => {
    const { built } = fixture();
    const controlBad = locate(built, "q05", "control");
    const { next: improved, row: improvedRow } = edit(makeRatings(built.packet), controlBad.review_id, controlBad.label);
    bad(improvedRow, "contradicted");
    expect(agg(built, improved).gatepass).toBe(true);
    const comparisonNoAssertion = locate(built, "q08", "comparison");
    const { next, row } = edit(improved, comparisonNoAssertion.review_id, comparisonNoAssertion.label);
    Object.assign(row, { claims: [], no_assertions: true, reviewer_explanation: "The answer asserts no facts." });
    const attested = agg(built, next);
    expect(attested.gatepass).toBe(true);
    expect(attested.per_arm.comparison.segmented_claims).toBe(16);
    expect(attested.per_arm.comparison.completeness.complete).toBe(17);
    const { next: incomplete, row: incompleteRow } = edit(next, comparisonNoAssertion.review_id, comparisonNoAssertion.label);
    incompleteRow.completeness = completeBlock({ status: "incomplete", explanation: "The answer did not address the request." });
    expect(agg(built, incomplete).gatepass).toBe(false);
  });
});
