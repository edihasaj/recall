import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ledgerPrompt, ledgerSection, packedIndexPrompt, packedIndexSection, packUnitIndex,
  unitIndexPrompt, unitIndexSection, validateLedger, validatePackedIndex,
  validateUnitIndex, visibleUnits,
} from "../benchmark/longmemeval-evidence-ledger.js";
import { evaluateCase, PACKED_ANSWER_FINALIZATION_GUIDANCE, parseArgs, runEvaluation } from "../benchmark/longmemeval-qa.js";
import { createModelCall, sha256, type Call, type Case, type Ranked } from "../benchmark/longmemeval-qa-support.js";

const source = (text: string): Ranked => ({ id: "answer_GOLD_SOURCE_ID", occurrence: 42, date: "2026/01/02 (Fri) 09:00", text });
const item: Case = {
  question_id: "GOLD_QUESTION_ID", question_type: "single-session-user", is_abstention: false,
  question: "Which color was chosen?", question_date: "2026/01/03", reference: "GOLD_REFERENCE",
  gold_session_ids: ["answer_GOLD_SOURCE_ID"],
  answer_prompt_prefix: "Task contract.\nQuestion: Which color was chosen?\nQuestion Date: 2026-01-03T00:00:00+00:00\n\nRetrieved Context:\n__RECALL_CONTEXT__",
  judge_prompt_template: "GOLD_REFERENCE __RECALL_CANDIDATE__",
  sessions: [source("user: I chose blue on Friday.\nassistant: Thanks.\nuser: Hidden red detail.")],
};
const response = (text: string | null, error: string | null = null, usage: Record<string, unknown> | null = null): Call => ({
  text, error, attempts: 1, elapsed_ms: 1, model: "mock", usage, prompt_sha256: text ? sha256(text) : "mock",
});

describe("LongMemEval evidence ledger", () => {
  it("keeps ledger opt-in at the command surface", () => {
    expect(parseArgs(["--out", "report.json"])).not.toHaveProperty("evidenceLedger");
    expect(parseArgs(["--out", "report.json", "--evidence-ledger", "quoted"])).toMatchObject({ evidenceLedger: "quoted" });
    expect(parseArgs(["--out", "report.json", "--evidence-ledger", "units"])).toMatchObject({ evidenceLedger: "units" });
    expect(parseArgs(["--out", "report.json", "--evidence-ledger", "packed"])).toMatchObject({ evidenceLedger: "packed" });
    expect(() => parseArgs(["--out", "report.json", "--evidence-ledger", "invalid"])).toThrow("evidence ledger");
  });

  it("keeps complete visible turns at range boundaries and excludes hidden turns", () => {
    const text = "user: complete 😀 turn\nassistant: hidden text\nuser: visible end";
    const firstEnd = text.indexOf("\nassistant:");
    const lastStart = text.indexOf("user: visible");
    const units = visibleUnits([source(text)], { sources: [{
      date: "2026/01/02", used_chars: 0,
      ranges: [{ start: 0, end: firstEnd }, { start: lastStart, end: text.length }],
    }] });
    expect(units.map((unit) => [unit.unit_index, unit.quote, unit.range])).toEqual([
      [1, "user: complete 😀 turn", { start: 0, end: firstEnd }],
      [3, "user: visible end", { start: lastStart, end: text.length }],
    ]);
    expect(JSON.stringify(ledgerPrompt("question", "clock", units))).not.toContain("hidden text");
    expect(visibleUnits([source(text)], { sources: [{
      date: "2026/01/02", used_chars: 0, ranges: [{ start: 0, end: firstEnd - 1 }],
    }] })).toEqual([]);
  });

  it("validates neutral references, deduplicates quotes, and retains empty ledgers", () => {
    const text = "user: blue Friday\nassistant: blue Friday";
    const units = visibleUnits([source(text)], {
      sources: [{ date: "2026/01/02", used_chars: text.length }],
    });
    const empty = validateLedger('{"facts":[]}', units);
    expect(empty).toMatchObject({ annotations: "unverified", facts: [], quotes: [] });
    const ledger = validateLedger(JSON.stringify({ facts: [
      { source_rank: 1, unit_index: 1, entity: "choice", relation: "selected", status: "final", event_time: "Friday" },
      { source_rank: 1, unit_index: 1, entity: "color", relation: "is", status: "stated", event_time: null },
    ] }), units);
    expect(ledger?.quotes).toHaveLength(1);
    expect(ledger?.quotes[0]).toMatchObject({ observation_date: "2026/01/02", speaker: "user", range: { start: 0, end: 17 } });
    expect(validateLedger('{"facts":[{"source_rank":2,"unit_index":1,"entity":"x","relation":"y","status":"z","event_time":null}]}', units)).toBeNull();
    expect(validateLedger('{"facts":[{"source_rank":1,"unit_index":1,"entity":"x","relation":"y","status":"z","event_time":"not present"}]}', units)).toBeNull();
    expect(validateLedger('{"facts":[{"source_rank":1,"unit_index":1,"entity":"x","relation":"y","status":"z","event_time":"  "}]}', units)).toBeNull();
    expect(validateLedger('```json\n{"facts":[]}\n```', units)).toBeNull();
  });

  it("rejects a final escaped ledger section over the hard budget", () => {
    const text = `user: ${"<".repeat(7_000)}`;
    const units = visibleUnits([source(text)], { sources: [{ date: "d", used_chars: text.length }] });
    const ledger = validateLedger('{"facts":[{"source_rank":1,"unit_index":1,"entity":"x","relation":"y","status":"z","event_time":null}]}', units);
    expect(ledger).not.toBeNull();
    expect(ledgerSection(ledger!)).toBeNull();
  });

  it("validates only neutral unit selections and materializes duplicate references once", () => {
    const text = "user: blue\nassistant: hidden\nuser: green";
    const firstEnd = text.indexOf("\nassistant:");
    const lastStart = text.indexOf("user: green");
    const units = visibleUnits([source(text)], { sources: [{
      date: "2026/01/02", used_chars: 0, ranges: [{ start: 0, end: firstEnd }, { start: lastStart, end: text.length }],
    }] });
    const empty = validateUnitIndex('{"selections":[]}', units);
    expect(empty).toMatchObject({ format: "units", selections: [], quotes: [] });
    const index = validateUnitIndex('{"selections":[{"source_rank":1,"unit_index":1},{"source_rank":1,"unit_index":1}]}', units);
    expect(index?.quotes).toHaveLength(1);
    expect(index?.quotes[0]).toMatchObject({ observation_date: "2026/01/02", speaker: "user", range: { start: 0, end: firstEnd } });
    expect(validateUnitIndex('{"selections":[],"facts":[]}', units)).toBeNull();
    expect(validateUnitIndex('{"selections":[{"source_rank":1,"unit_index":1,"entity":"forbidden"}]}', units)).toBeNull();
    expect(validateUnitIndex('{"selections":[{"source_rank":1,"unit_index":2}]}', units)).toBeNull();
    expect(JSON.stringify(unitIndexPrompt("question", "clock", units))).not.toContain("answer_GOLD_SOURCE_ID");
  });

  it("rejects an oversized escaped unit index without truncating it", () => {
    const text = `user: ${"<".repeat(7_000)}`;
    const units = visibleUnits([source(text)], { sources: [{ date: "d", used_chars: text.length }] });
    const index = validateUnitIndex('{"selections":[{"source_rank":1,"unit_index":1}]}', units);
    expect(index).not.toBeNull();
    expect(unitIndexSection(index!)).toBeNull();
  });

  it("validates every packed reference before stably packing whole visible units", () => {
    const text = `user: ${"<".repeat(4_000)}\nassistant: keep one\nuser: keep two`;
    const units = visibleUnits([source(text)], { sources: [{ date: "d", used_chars: text.length }] });
    expect(validatePackedIndex('{"selections":[{"source_rank":1,"unit_index":2},{"source_rank":1,"unit_index":9}]}', units)).toBeNull();
    const parsed = validatePackedIndex('{"selections":[{"source_rank":1,"unit_index":1},{"source_rank":1,"unit_index":1},{"source_rank":1,"unit_index":2},{"source_rank":1,"unit_index":3}]}', units);
    const packed = packUnitIndex(parsed!, units);
    expect(packed).toMatchObject({
      format: "packed", omitted_count: 1,
      diagnostics: {
        original_selections: [{ source_rank: 1, unit_index: 1 }, { source_rank: 1, unit_index: 1 }, { source_rank: 1, unit_index: 2 }, { source_rank: 1, unit_index: 3 }],
        duplicate_refs: [{ source_rank: 1, unit_index: 1 }],
        included_refs: [{ source_rank: 1, unit_index: 2 }, { source_rank: 1, unit_index: 3 }],
        omitted_refs: [{ source_rank: 1, unit_index: 1, reason: "budget" }],
      },
    });
    expect(packed?.quotes.map((unit) => unit.quote)).toEqual(["assistant: keep one", "user: keep two"]);
    const section = packedIndexSection(packed!);
    expect(section?.chars).toBeLessThanOrEqual(18_000);
    expect(section?.text).not.toContain("diagnostics");

    const none = packUnitIndex(validatePackedIndex('{"selections":[{"source_rank":1,"unit_index":1}]}', units)!, units);
    expect(none).toMatchObject({ omitted_count: 1, quotes: [], diagnostics: { included_refs: [] } });
    expect(packUnitIndex({ selections: [{ source_rank: 1, unit_index: 99 }] }, units)).toBeNull();
    expect(packedIndexPrompt("question", "clock", units)).not.toContain("answer_GOLD_SOURCE_ID");
  });

  it("keeps the final packed frame within budget at the two-digit omission boundary", () => {
    const text = Array.from({ length: 24 }, (_, index) => `user: ${index} ${"<".repeat(4_000)}`).join("\n");
    const units = visibleUnits([source(text)], { sources: [{ date: "d", used_chars: text.length }] });
    const selections = Array.from({ length: 24 }, (_, index) => ({ source_rank: 1, unit_index: index + 1 }));
    const packed = packUnitIndex(validatePackedIndex(JSON.stringify({ selections }), units)!, units);
    expect(packed).toMatchObject({ omitted_count: 24, quotes: [] });
    expect(packedIndexSection(packed!)?.chars).toBeLessThanOrEqual(18_000);
  });

  it("runs ledger, answer, then judge without leaking hidden metadata", async () => {
    const calls: string[] = [];
    const row = await evaluateCase(item, {
      retrieval: "cached", topK: 1, contextChars: 1_000, evidenceLedger: "quoted", evidencePolicy: "system",
    }, ["answer_GOLD_SOURCE_ID"], async (kind, prompt) => {
      calls.push(kind);
      if (kind === "ledger") {
        expect(prompt).toContain(item.question);
        expect(prompt).toContain("2026-01-03T00:00:00+00:00");
        expect(prompt).not.toContain(item.reference);
        expect(prompt).not.toContain(item.question_id);
        expect(prompt).not.toContain(item.gold_session_ids[0]!);
        return response('{"facts":[{"source_rank":1,"unit_index":1,"entity":"choice","relation":"selected","status":"final","event_time":"Friday"}]}');
      }
      if (kind === "answer") {
        expect(prompt).toContain("UNTRUSTED_EVIDENCE_LEDGER_JSON");
        expect(prompt).not.toContain(item.reference);
        expect(prompt).not.toContain(item.gold_session_ids[0]!);
        return response('{"answer":"blue","reasoning":"quoted"}');
      }
      expect(prompt).toContain(item.reference);
      expect(prompt).toContain("blue");
      return response('{"correct":true}');
    });
    expect(calls).toEqual(["ledger", "answer", "judge"]);
    expect(row.correct).toBe(true);
    expect(row.ledger_chars).toBeGreaterThan(0);
    expect(row.final_answer_prompt_sha256).not.toBeNull();
    expect(row.validated_ledger?.quotes).toHaveLength(1);
    expect(row.evidence?.text).not.toContain("UNTRUSTED_EVIDENCE_LEDGER_JSON");
  });

  it("fails invalid and oversized ledgers before drafting or judging", async () => {
    let calls = 0;
    const invalid = await evaluateCase(item, {
      retrieval: "cached", topK: 1, contextChars: 1_000, evidenceLedger: "quoted", evidencePolicy: "system",
    }, ["answer_GOLD_SOURCE_ID"], async () => {
      calls++;
      return response('{"facts":[{"source_rank":9,"unit_index":1,"entity":"x","relation":"y","status":"z","event_time":null}]}');
    });
    expect(calls).toBe(1);
    expect(invalid).toMatchObject({ correct: false, error: "malformed_ledger", answer_call: null, judge_call: null });

    const large = { ...item, sessions: [source(`user: ${"<".repeat(7_000)}`)] };
    calls = 0;
    const oversized = await evaluateCase(large, {
      retrieval: "cached", topK: 1, contextChars: 10_000, evidenceLedger: "quoted", evidencePolicy: "system",
    }, ["answer_GOLD_SOURCE_ID"], async () => {
      calls++;
      return response('{"facts":[{"source_rank":1,"unit_index":1,"entity":"x","relation":"y","status":"z","event_time":null}]}');
    });
    expect(calls).toBe(1);
    expect(oversized).toMatchObject({ correct: false, error: "ledger_oversized", answer_call: null, judge_call: null });
  });

  it("runs units mode as a metadata-only reading index and stops invalid selections before drafting", async () => {
    const calls: string[] = [];
    const row = await evaluateCase(item, {
      retrieval: "cached", topK: 1, contextChars: 1_000, evidenceLedger: "units", evidencePolicy: "system",
    }, ["answer_GOLD_SOURCE_ID"], async (kind, prompt) => {
      calls.push(kind);
      if (kind === "ledger") {
        expect(prompt).toContain(item.question);
        expect(prompt).toContain("2026-01-03T00:00:00+00:00");
        expect(prompt).not.toContain(item.reference);
        expect(prompt).not.toContain(item.gold_session_ids[0]!);
        return response('{"selections":[{"source_rank":1,"unit_index":1},{"source_rank":1,"unit_index":1}]}');
      }
      if (kind === "answer") {
        expect(prompt).toContain("UNTRUSTED_EVIDENCE_UNIT_INDEX_JSON");
        expect(prompt).not.toContain("event_time");
        return response('{"answer":"blue","reasoning":"source"}');
      }
      return response('{"correct":true}');
    });
    expect(calls).toEqual(["ledger", "answer", "judge"]);
    expect(row).toMatchObject({ ledger_format: "units", ledger_index_chars: expect.any(Number), ledger_index_sha256: expect.any(String) });
    expect(row.validated_ledger).toMatchObject({ format: "units", selections: [{ source_rank: 1, unit_index: 1 }, { source_rank: 1, unit_index: 1 }] });
    expect((row.validated_ledger as { quotes: unknown[] }).quotes).toHaveLength(1);

    let invalidCalls = 0;
    const invalid = await evaluateCase(item, {
      retrieval: "cached", topK: 1, contextChars: 1_000, evidenceLedger: "units", evidencePolicy: "system",
    }, ["answer_GOLD_SOURCE_ID"], async () => {
      invalidCalls++;
      return response('{"selections":[{"source_rank":1,"unit_index":9}]}');
    });
    expect(invalidCalls).toBe(1);
    expect(invalid).toMatchObject({ correct: false, error: "malformed_ledger", answer_call: null, judge_call: null });

    const large = { ...item, sessions: [source(`user: ${"<".repeat(7_000)}`)] };
    let oversizedCalls = 0;
    const oversized = await evaluateCase(large, {
      retrieval: "cached", topK: 1, contextChars: 10_000, evidenceLedger: "units", evidencePolicy: "system",
    }, ["answer_GOLD_SOURCE_ID"], async () => {
      oversizedCalls++;
      return response('{"selections":[{"source_rank":1,"unit_index":1}]}');
    });
    expect(oversizedCalls).toBe(1);
    expect(oversized).toMatchObject({ correct: false, error: "ledger_oversized", answer_call: null, judge_call: null });
  });

  it("keeps raw evidence while packed mode reports every budget omission", async () => {
    const large = { ...item, sessions: [source(`user: ${"<".repeat(4_000)}\nassistant: retained source`)] };
    const calls: string[] = [];
    const row = await evaluateCase(large, {
      retrieval: "cached", topK: 1, contextChars: 10_000, evidenceLedger: "packed", evidencePolicy: "system",
    }, ["answer_GOLD_SOURCE_ID"], async (kind, prompt) => {
      calls.push(kind);
      if (kind === "ledger") return response('{"selections":[{"source_rank":1,"unit_index":1},{"source_rank":1,"unit_index":2}]}');
      if (kind === "answer") {
        expect(prompt).toContain("<".repeat(100));
        expect(prompt).toContain("UNTRUSTED_EVIDENCE_PACKED_INDEX_JSON");
        expect(prompt).not.toContain("event_time");
        return response('{"answer":"blue","reasoning":"source"}');
      }
      expect(prompt).toContain(item.reference);
      return response('{"correct":true}');
    });
    expect(calls).toEqual(["ledger", "answer", "judge"]);
    expect(row).toMatchObject({
      ledger_format: "packed", answer_format: "standalone_packed",
      answer_format_sha256: sha256(PACKED_ANSWER_FINALIZATION_GUIDANCE),
      packed_index_diagnostics: {
        included_refs: [{ source_rank: 1, unit_index: 2 }],
        omitted_refs: [{ source_rank: 1, unit_index: 1, reason: "budget" }],
      },
    });
    expect(row.validated_ledger).toMatchObject({ format: "packed", omitted_count: 1 });

    let invalidCalls = 0;
    const invalid = await evaluateCase(item, {
      retrieval: "cached", topK: 1, contextChars: 1_000, evidenceLedger: "packed", evidencePolicy: "system",
    }, ["answer_GOLD_SOURCE_ID"], async () => {
      invalidCalls++;
      return response('{"selections":[{"source_rank":1,"unit_index":1},{"source_rank":1,"unit_index":9}]}');
    });
    expect(invalidCalls).toBe(1);
    expect(invalid).toMatchObject({ correct: false, error: "malformed_ledger", answer_call: null, judge_call: null });
  });

  it("leaves the baseline row shape and answer path unchanged when unopted", async () => {
    const row = await evaluateCase(item, {
      retrieval: "cached", topK: 1, contextChars: 1_000,
    }, ["answer_GOLD_SOURCE_ID"], async (kind) =>
      response(kind === "answer" ? '{"answer":"blue"}' : '{"correct":true}'));
    expect(row).not.toHaveProperty("ledger_call");
    expect(row).not.toHaveProperty("final_answer_prompt_sha256");
    expect(row.correct).toBe(true);
  });

  it("uses a fixed isolated native ledger request and rejects invalid ledger configurations before calls", async () => {
    const keyFile = join(mkdtempSync(join(tmpdir(), "recall-ledger-key-")), "token");
    writeFileSync(keyFile, "test-token");
    vi.stubEnv("DGX_BASE_URL", "http://127.0.0.1:45678/v1");
    vi.stubEnv("DGX_KEY_FILE", keyFile);
    try {
      const quotedBodies: unknown[] = [];
      const call = createModelCall("qwen-local", async (_url, init) => {
        const body = JSON.parse(String(init.body));
        quotedBodies.push(body);
        if (body.text.format.name === "benchmark_evidence_ledger") {
          expect(body.reasoning).toEqual({ effort: "low" });
          expect(body.max_output_tokens).toBe(8192);
          expect(body.text.format).toMatchObject({
            strict: true, schema: {
              required: ["facts"], additionalProperties: false,
              properties: {
                facts: {
                  maxItems: 24, items: {
                    required: ["source_rank", "unit_index", "entity", "relation", "status", "event_time"],
                    additionalProperties: false,
                  },
                },
              },
            },
          });
          expect(body.input[0].content).not.toContain("ANSWER_POLICY_SENTINEL");
          return new Response(JSON.stringify({ status: "completed", output_text: '{"facts":[]}' }));
        }
        if (body.text.format.name === "benchmark_answer") {
          expect(body.reasoning).toEqual({ effort: "high" });
          expect(body.max_output_tokens).toBe(16384);
          return new Response(JSON.stringify({ status: "completed", output_text: '{"answer":"ok","reasoning":"ok"}' }));
        }
        expect(body.reasoning).toEqual({ effort: "none" });
        expect(body.max_output_tokens).toBe(4096);
        return new Response(JSON.stringify({ status: "completed", output_text: '{"correct":true,"reason":"ok"}' }));
      }, { structuredOutput: true, reasoningEffort: "adaptive", maxOutputTokens: 16384, answerInstructions: "ANSWER_POLICY_SENTINEL" });
      expect((await call("ledger", "ledger prompt")).request_config).toEqual({ reasoning_effort: "low", max_output_tokens: 8192 });
      await call("answer", "answer prompt", { question: "How many records are there?" });
      await call("judge", "judge prompt");
      const unitBodies: unknown[] = [];
      const unitCall = createModelCall("qwen-local", async (_url, init) => {
        const body = JSON.parse(String(init.body));
        unitBodies.push(body);
        if (body.text.format.name === "benchmark_evidence_unit_index") {
          expect(body.reasoning).toEqual({ effort: "low" });
          expect(body.max_output_tokens).toBe(8192);
          expect(body.text.format).toMatchObject({
            strict: true, schema: {
              required: ["selections"], additionalProperties: false,
              properties: {
                selections: {
                  maxItems: 24, items: {
                    required: ["source_rank", "unit_index"], additionalProperties: false,
                  },
                },
              },
            },
          });
          expect(body.input[0].content).not.toContain("ANSWER_POLICY_SENTINEL");
          return new Response(JSON.stringify({ status: "completed", output_text: '{"selections":[]}' }));
        }
        if (body.text.format.name === "benchmark_answer") {
          return new Response(JSON.stringify({ status: "completed", output_text: '{"answer":"ok","reasoning":"ok"}' }));
        }
        return new Response(JSON.stringify({ status: "completed", output_text: '{"correct":true,"reason":"ok"}' }));
      }, { structuredOutput: true, reasoningEffort: "adaptive", maxOutputTokens: 16384, answerInstructions: "ANSWER_POLICY_SENTINEL", ledgerFormat: "units" });
      expect((await unitCall("ledger", "units prompt")).request_config).toEqual({ reasoning_effort: "low", max_output_tokens: 8192 });
      await unitCall("answer", "answer prompt", { question: "How many records are there?" });
      await unitCall("judge", "judge prompt");
      expect(unitBodies.slice(1)).toEqual(quotedBodies.slice(1));
      const packedCalls: unknown[] = [];
      const packedCall = createModelCall("qwen-local", async (_url, init) => {
        const body = JSON.parse(String(init.body));
        packedCalls.push(body);
        if (body.text.format.name === "benchmark_evidence_packed_index") {
          expect(body.input[0].content).not.toContain("PACKED_FINALIZATION_SENTINEL");
          return new Response(JSON.stringify({ status: "completed", output_text: '{"selections":[]}' }));
        }
        if (body.text.format.name === "benchmark_answer") {
          expect(body.input[0].content).toContain("PACKED_FINALIZATION_SENTINEL");
          return new Response(JSON.stringify({ status: "completed", output_text: '{"answer":"ok","reasoning":"ok"}' }));
        }
        expect(body.input[0].content).not.toContain("PACKED_FINALIZATION_SENTINEL");
        return new Response(JSON.stringify({ status: "completed", output_text: '{"correct":true,"reason":"ok"}' }));
      }, { structuredOutput: true, reasoningEffort: "adaptive", maxOutputTokens: 16384, answerInstructions: "ANSWER_POLICY_SENTINEL\nPACKED_FINALIZATION_SENTINEL", ledgerFormat: "packed" });
      await packedCall("ledger", "packed prompt");
      await packedCall("answer", "answer prompt", { question: "How many records are there?" });
      await packedCall("judge", "judge prompt");
      expect(packedCalls).toHaveLength(3);
    } finally { vi.unstubAllEnvs(); }

    const dir = mkdtempSync(join(tmpdir(), "recall-ledger-options-"));
    const input = join(dir, "input.json");
    writeFileSync(input, JSON.stringify({ provenance: {}, cases: [item] }));
    const base = { input, out: join(dir, "report.json"), provider: "qwen-local" as const, retrieval: "lexical" as const, concurrency: 1, contextChars: 1000, topK: 1, evidenceLedger: "quoted" as const };
    await expect(runEvaluation(base, async () => response('{"facts":[]}'))).rejects.toThrow("robust");
    const locked = { ...base, requestMode: "robust" as const, evidencePolicy: "system" as const, reasoningEffort: "adaptive" as const, maxOutputTokens: 16384 };
    await expect(runEvaluation({ ...locked, out: join(dir, "grounded.json"), answerCheck: "grounded" }, async () => response('{"facts":[]}'))).rejects.toThrow("cannot be combined");
    let calls = 0;
    const noCall = async () => {
      calls++;
      return response('{"facts":[]}');
    };
    await expect(runEvaluation({ ...base, out: join(dir, "missing-adaptive.json"), requestMode: "robust", evidencePolicy: "system" }, noCall)).rejects.toThrow("adaptive reasoning");
    await expect(runEvaluation({ ...base, out: join(dir, "units-missing-adaptive.json"), evidenceLedger: "units", requestMode: "robust", evidencePolicy: "system" }, noCall)).rejects.toThrow("adaptive reasoning");
    await expect(runEvaluation({ ...base, out: join(dir, "packed-missing-adaptive.json"), evidenceLedger: "packed", requestMode: "robust", evidencePolicy: "system" }, noCall)).rejects.toThrow("adaptive reasoning");
    await expect(runEvaluation({ ...base, out: join(dir, "wrong-budget.json"), requestMode: "robust", evidencePolicy: "system", reasoningEffort: "adaptive", maxOutputTokens: 8192 }, noCall)).rejects.toThrow("16384-token");
    await expect(runEvaluation({ ...locked, out: join(dir, "too-concurrent.json"), concurrency: 4 }, noCall)).rejects.toThrow("at most three");
    await expect(runEvaluation({ ...locked, out: join(dir, "units-grounded.json"), evidenceLedger: "units", answerCheck: "grounded" }, noCall)).rejects.toThrow("cannot be combined");
    await expect(runEvaluation({ ...locked, out: join(dir, "units-concurrent.json"), evidenceLedger: "units", concurrency: 4 }, noCall)).rejects.toThrow("at most three");
    await expect(runEvaluation({ ...locked, out: join(dir, "packed-grounded.json"), evidenceLedger: "packed", answerCheck: "grounded" }, noCall)).rejects.toThrow("cannot be combined");
    await expect(runEvaluation({ ...locked, out: join(dir, "packed-concurrent.json"), evidenceLedger: "packed", concurrency: 4 }, noCall)).rejects.toThrow("at most three");
    expect(calls).toBe(0);
  });

  it("includes ledger usage and preserves missing-usage diagnostics in the Python summary", () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-ledger-summary-"));
    const lexical = join(dir, "lexical.json"), hindsight = join(dir, "hindsight.json.gz"), out = join(dir, "summary.json");
    writeFileSync(lexical, JSON.stringify({
      status: "complete", comparison_valid: true, generation_blinding: "yes",
      started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:00:01Z",
      selected_question_ids: ["q"], results: [{
        question_id: "q", question_type: "single-session-user", is_abstention: false,
        correct: true, error: null, evidence: { chars: 1, sources: [] }, ledger_chars: 17,
        ledger_call: response('{"facts":[]}', null, { input_tokens: 2, output_tokens: 3, total_tokens: 5 }),
        answer_call: response('{"answer":"x"}'), judge_call: response('{"correct":true}', null, { input_tokens: 7, output_tokens: 11, total_tokens: 18 }),
      }],
    }));
    writeFileSync(hindsight, gzipSync(JSON.stringify({ results: [{ query_id: "q", correct: true }] })));
    const result = spawnSync("uv", ["run", "--offline", "--no-project", "python", "benchmark/summarize-longmemeval-qa.py", "--lexical", lexical, "--hindsight", hindsight, "--out", out], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).fresh_lexical).toMatchObject({
      observed_tokens: { input: 9, output: 14, total: 23 }, calls_with_missing_usage: 1,
      source_evidence_chars_mean: 1, derived_ledger_chars_mean: 17,
      answer_context_chars_mean: 18,
    });
  });
});
