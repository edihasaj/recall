import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { initStandaloneDb, closeDb } from "../src/db/client.js";
import { processCorrection } from "../src/capture/correction.js";
import { isFixedReplyInstruction } from "../src/capture/fixed-reply.js";
import { hasNonDurableProvenance } from "../src/capture/provenance.js";
import { createMemory, getMemory, promoteMemory, queryMemories } from "../src/models/memory.js";
import { compileContext, compileContextHybrid } from "../src/compiler/context.js";
import { applyExtractRulesFromPrompt } from "../src/maintenance/appliers.js";
import { applyPromoteRepeat, evaluatePromotionCandidates } from "../src/maintenance/promote.js";
import { planPromoteRepeats, qualityReasons } from "../src/maintenance/cleanup.js";
import { quarantineGeneratedMemories } from "../src/maintenance/provenance.js";
import { peekTasks } from "../src/maintenance/tasks.js";
import { memoryInjections, memoryValueEvents } from "../src/db/schema.js";
import type { MaintenanceTask } from "../src/types.js";

const raw = "Do not call tools. Reply only LOCAL_REVIEW_READY.";
const rewritten = "Do not use tools. Use Reply only LOCAL_REVIEW_READY instead.";
const repo = "fixture/fixed-reply";
const timestamp = "2026-10-18T20:26:30.000Z";
function freshDb() { return initStandaloneDb(join(mkdtempSync(join(tmpdir(), "recall-fixed-reply-")), "recall.db")); }
function evidence(context = raw) { return [{ type: "session_correction" as const, session: "capture", timestamp, context }]; }
function task(rawPrompt: string): MaintenanceTask {
  return { id: "task", kind: "extract_rules_from_prompt", status: "submitted", priority: 14,
    repo, target_key: "prompt:test", payload: { repo, raw_prompt: rawPrompt, session_id: "capture" },
    result: null, failure_reason: null, claimed_by: "test", claimed_at: timestamp, claim_expires_at: null,
    submitted_at: timestamp, completed_at: null, created_at: timestamp, attempts: 1, max_attempts: 3 };
}

beforeEach(() => {
  vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "true");
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Test forbids network"))));
});
afterEach(() => { closeDb(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("fixed response contracts stay in their task", () => {
  it("handles adversarial prefix repetition without regex backtracking", () => {
    expect(isFixedReplyInstruction("from now on ".repeat(10_000) + "reply differently.")).toBe(false);
  });
  it.each([raw, rewritten, "Please respond only OTHER_PROBE_OK.", "Output exactly `two arbitrary words`.",
    "Do not inspect files; reply only 'green light'.", "Always answer only READY", "Return THIRD_TOKEN only.",
    "Don't use tools. Reply only `probe.finished;ready`.", 'Respond exactly "test finished. Ready!".',
    "Do not call tools, reply only DIFFERENT_PROBE_READY.", "Do not call tools.\n- Reply only BULLET_TEST_READY.",
    "Do not call tools and reply only SECOND_TEST_READY.", "Do not call tools then respond only FOURTH_TEST_READY."])(
    "recognizes a literal response contract: %s", text => expect(isFixedReplyInstruction(text)).toBe(true),
  );
  it.each(["Always reply in Spanish.", "Always output JSON.", "Always respond only in Albanian.",
    "Always reply only with valid JSON.", "Never use tools without my approval.",
    "Never reply only DONE; explain your findings.", "Always reply only concisely.",
    "Always respond only professionally.", "Always answer only truthfully.", "Always reply only English.",
    "Always reply only ENGLISH."])(
    "preserves a real standing preference: %s", text => expect(isFixedReplyInstruction(text)).toBe(false),
  );
  it.each(["true", "false"])("rejects the real prompt before capture/enqueue (LLM disabled=%s)", async disabled => {
    const db = freshDb();
    vi.stubEnv("RECALL_LLM_CAPTURE_DISABLED", disabled);
    vi.stubEnv("OPENAI_API_KEY", "fixture-unused-key");
    const result = await processCorrection(db, raw, { sessionId: "probe", agent: "codex", force_semantic_capture: true });
    expect(result.ids).toEqual([]); expect(result.pendingTaskId).toBeUndefined();
    expect(queryMemories(db, {})).toEqual([]); expect(peekTasks(db)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a durable LLM verdict on both a poisoned prompt and an invented fixed-reply rule", () => {
    const db = freshDb();
    for (const rawPrompt of [raw, "Always use npm in this repo."]) {
      applyExtractRulesFromPrompt(db, task(rawPrompt), { rules: [{ text: rewritten, type: "rule", scope: "global", confidence: 0.99, durability: "durable" }] });
    }
    expect(queryMemories(db, {})).toEqual([]);
  });
  it.each(["Do not call tools, reply only COMMA_TEST_READY.", "Do not call tools.\n- Reply only LIST_TEST_READY.",
    "Do not call tools and reply only JOINED_TEST_READY."])("blocks capture and legacy paraphrases of %s", async prompt => {
    const db = freshDb(); vi.stubEnv("RECALL_LLM_CAPTURE_DISABLED", "true");
    expect((await processCorrection(db, prompt, { sessionId: "probe", force_semantic_capture: true })).ids).toEqual([]);
    applyExtractRulesFromPrompt(db, task(prompt), { rules: [{ text: "Avoid using external tools.", type: "rule", scope: "global", confidence: 0.99, durability: "durable" }] });
    expect(queryMemories(db, {})).toEqual([]);
    const id = createMemory(db, { type: "rule", text: "Avoid using external tools.", scope: "global", source: "user_correction", confidence: 0.99, evidence: evidence(prompt) });
    expect(hasNonDurableProvenance(getMemory(db, id)!)).toBe(true);
    expect(compileContext(db, { repo }).memories_included).toEqual([]);
  });
  it("does not promote historical score-eight evidence, even after repetition or a stale plan", () => {
    const db = freshDb();
    const id = createMemory(db, { type: "rule", text: rewritten, scope: "global", source: "user_correction", confidence: 0.47, evidence: evidence() });
    db.insert(memoryInjections).values({ id: randomUUID(), memory_id: id, session_id: "followed", repo,
      injected_at: timestamp, outcome: "followed", outcome_at: timestamp }).run();
    for (let n = 0; n < 5; n++) db.insert(memoryValueEvents).values({ id: randomUUID(), memory_id: id,
      session_id: `used-${n}`, repo, event_type: "used", source: "hook:codex", created_at: timestamp }).run();
    const [evaluation] = evaluatePromotionCandidates(db, { fragmentReasons: qualityReasons });
    expect(evaluation.score).toBe(8); expect(evaluation.decision).toBe("suppressed");
    expect(evaluation.explanation).toContain("suppressed_due_to_non_durable_provenance");
    expect(planPromoteRepeats(db)).toEqual([]);
    db.$client.prepare("UPDATE memories SET repetition_count=5 WHERE id=?").run(id);
    expect(planPromoteRepeats(db)).toEqual([]);
    applyPromoteRepeat(db, "stale-plan", { kind: "promote_repeat_correction", memory_id: id, text: rewritten, matched_pattern: "evidence_score", score: 8 });
    expect(getMemory(db, id)?.status).toBe("candidate");
    expect(promoteMemory(db, id, "repeat_correction")).toBe(false);
  });
  it("blocks legacy active rows in ambient and explicit retrieval, then quarantines them reversibly", async () => {
    const db = freshDb();
    const ids = [rewritten, "Avoid using external tools."].map(text => createMemory(db, {
      type: "rule", text, scope: "global", source: "user_correction", confidence: 0.99, evidence: evidence(),
    }));
    expect(compileContext(db, { repo }).memories_included).toEqual([]);
    expect((await compileContextHybrid(db, { repo, query_text: rewritten, config: { include_candidates: true } })).memories_included).toEqual([]);
    expect(quarantineGeneratedMemories(db, true).sort()).toEqual(ids.sort());
    for (const id of ids) expect(getMemory(db, id)).toMatchObject({ status: "candidate", auto_inject: false });
  });
  it("does not invalidate independently sourced durable evidence because a probe was also present", () => {
    const db = freshDb();
    const text = "Never use external tools without my approval.";
    const id = createMemory(db, { type: "rule", text, scope: "global", source: "user_correction", confidence: 0.9,
      evidence: [...evidence(), ...evidence(text)] });
    expect(hasNonDurableProvenance(getMemory(db, id)!)).toBe(false);
    expect(compileContext(db, { repo }).memories_included).toContain(id);
  });
  it("continues capturing durable output-format and permission preferences", async () => {
    const db = freshDb(); vi.stubEnv("RECALL_LLM_CAPTURE_DISABLED", "true");
    for (const text of ["Always output JSON.", "Never use tools without my approval."]) {
      const { ids } = await processCorrection(db, text, { repo, sessionId: "real-user", force_semantic_capture: true });
      expect(ids).toHaveLength(1); expect(hasNonDurableProvenance(getMemory(db, ids[0])!)).toBe(false);
    }
  });
});
