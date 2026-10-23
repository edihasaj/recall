import { describe, expect, it } from "vitest";
import { sha256 } from "../benchmark/longmemeval-qa-support.js";
import { aggregateLockedGrounding, buildGroundingPackets, canonicalGroundingJson, privateArmMapCore, validateGroundingRatings } from "../benchmark/longmemeval-inference-grounding.js";
import type { ContextReplayInput } from "../benchmark/longmemeval-context-replay-input.js";

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
  const selection = { development_ids: input.selected_question_ids, selected_review_ids: input.selected_question_ids.slice(0, 17), mask_seed: 20261022 };
  const report = { status: "complete", comparison_valid: true, execution_mode: "native", results: input.cases.flatMap((item) => [{ question_id: item.question_id, arm: "control" as const, answer: item.index === 0 ? null : `control-${item.index}`, correct: false, drafts: "SECRET_DRAFT" }, { question_id: item.question_id, arm: "comparison" as const, answer: `comparison-${item.index}`, correct: true, judge_reason: "SECRET_JUDGE" }]) };
  return { input, selection, report };
}
function ratings(packet: ReturnType<typeof buildGroundingPackets>["packet"]) {
  return packet.reviews.flatMap((review) => review.answers.map((answer) => {
    if (!answer.generated) return { review_id: review.review_id, label: answer.label, status: "no_answer", claims: [], segmentation_complete: true, segmentation_uncertain: false };
    const quote = answer.answer!.slice(0, 4), start = answer.answer!.indexOf(quote);
    const contextQuote = review.context.slice(0, 8);
    return { review_id: review.review_id, label: answer.label, status: "rated", segmentation_complete: true, segmentation_uncertain: false, claims: [{ proposition_id: "p1", proposition: "one fact", label: "supported", answer_spans: [{ quote, start, end: start + quote.length }], context_anchors: [{ quote: contextQuote, start: 0, end: contextQuote.length }] }] };
  }));
}

describe("LongMemEval inference grounding", () => {
  it("masks a stable selected subset while keeping result outcomes and private IDs out of the packet", () => {
    const { input, selection, report } = fixture();
    const first = buildGroundingPackets(input, report, selection), reordered = buildGroundingPackets(input, { ...report, results: [...report.results].reverse() }, selection);
    expect(first.packet).toEqual(reordered.packet);
    expect(first.packet.reviews).toHaveLength(17);
    expect(first.packet.reviews.flatMap((review) => review.answers)).toHaveLength(34);
    expect(first.packet.reviews.some((review) => review.answers.some((answer) => answer.answer === null))).toBe(true);
    const visible = JSON.stringify(first.packet);
    expect(visible).not.toContain("SECRET_REFERENCE");
    expect(visible).not.toContain("SECRET_DRAFT");
    expect(visible).not.toContain("SECRET_JUDGE");
    expect(visible).not.toContain('"q00"');
    expect(first.private_arm_map.packet_canonical_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.private_arm_map.reviews.some((row) => row.question_id === "q00")).toBe(true);
  });

  it("validates exact rating coverage, UTF-16 quote ranges, and unsupported/contradicted union counts", () => {
    const { input, selection, report } = fixture(), built = buildGroundingPackets(input, report, selection);
    const rows = ratings(built.packet);
    const firstGenerated = rows.find((row) => row.status === "rated")!;
    firstGenerated.claims[0]!.label = "unsupported";
    const second = rows.find((row) => row.status === "rated" && row !== firstGenerated)!;
    second.claims[0]!.label = "contradicted";
    const result = validateGroundingRatings(built.packet, rows);
    expect(result.total_bad_union).toBe(2);
    expect(result.responses.filter((row) => row.affected)).toHaveLength(2);
    const invalid = structuredClone(rows); (invalid.find((row) => row.status === "rated")!.claims[0]!.answer_spans[0]!.start)++;
    expect(() => validateGroundingRatings(built.packet, invalid)).toThrow("Invalid grounding claim");
    expect(() => validateGroundingRatings(built.packet, rows.slice(1))).toThrow("34");
  });

  it("requires a locked raw rating hash before unmasking and blocks unresolved or uncertain gates", () => {
    const { input, selection, report } = fixture(), built = buildGroundingPackets(input, report, selection), rows = ratings(built.packet);
    rows.find((row) => row.status === "rated")!.segmentation_uncertain = true;
    const raw = JSON.stringify(rows), commitment = { phase: "packet_prepared" as const, packet_canonical_sha256: sha256(canonicalGroundingJson(built.packet)), private_map_canonical_sha256: sha256(canonicalGroundingJson(built.private_arm_map)), pretrial_map_commitment_raw_sha256: "pretrial", map_core_canonical_sha256: sha256(canonicalGroundingJson(privateArmMapCore(built.private_arm_map))) };
    const commitmentBytes = JSON.stringify(commitment), commitmentHash = sha256(commitmentBytes);
    const lock = { phase: "ratings_locked" as const, commitment_raw_sha256: commitmentHash, ratings_raw_sha256: sha256(raw), packet_canonical_sha256: commitment.packet_canonical_sha256, private_map_canonical_sha256: commitment.private_map_canonical_sha256 };
    expect(() => aggregateLockedGrounding(built.packet, raw, built.private_arm_map, lock, commitmentBytes, "bad")).toThrow("commitment hash mismatch");
    const aggregate = aggregateLockedGrounding(built.packet, raw, built.private_arm_map, lock, commitmentBytes, commitmentHash);
    expect(aggregate.gatepass).toBe(false);
    expect(aggregate.segmentation_flags).toBe(1);
    expect(aggregate.per_arm.control.finalcoverage + aggregate.per_arm.comparison.finalcoverage).toBe(33);
    const swapped = structuredClone(built.private_arm_map); [swapped.reviews[0]!.labels.A, swapped.reviews[0]!.labels.B] = [swapped.reviews[0]!.labels.B, swapped.reviews[0]!.labels.A];
    expect(() => aggregateLockedGrounding(built.packet, raw, swapped, lock, commitmentBytes, commitmentHash)).toThrow("private map hash");
  });

  it("rejects partial reports, duplicate arms, and generated answers marked as no-answer", () => {
    const { input, selection, report } = fixture();
    expect(() => buildGroundingPackets(input, { ...report, status: "partial" }, selection)).toThrow("Completed");
    expect(() => buildGroundingPackets(input, { ...report, execution_mode: "injected", comparison_valid: false }, selection)).toThrow("Completed");
    const duplicate = { ...report, results: [...report.results, report.results[0]!] };
    expect(() => buildGroundingPackets(input, duplicate, selection)).toThrow("Duplicate");
    const built = buildGroundingPackets(input, report, selection), rows = ratings(built.packet);
    rows.find((row) => row.status === "rated")!.status = "no_answer";
    expect(() => validateGroundingRatings(built.packet, rows)).toThrow("Generated");
  });
});
