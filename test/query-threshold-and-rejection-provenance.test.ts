import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import { compileContext, compileContextHybrid } from "../src/compiler/context.js";
import { createMemory, getMemory, reactivateMemory, rejectMemory } from "../src/models/memory.js";
import { processCorrection } from "../src/capture/correction.js";
import { recordAudit } from "../src/audit/trail.js";

let dbCounter = 0;
function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-threshold-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

const REPO = "test/repo";

// Regression: a rule at 0.67 vanished from `query` while `list` showed it,
// because the real gate is the repo's adaptive threshold (0.68 on the repo
// this was found on), not the 0.6 the tool advertised. The agent read the
// empty result as "no such rule exists" and acted against a team convention.
describe("compile confidence gate is explainable", () => {
  it("reports the gate it applied and the memories that only just missed it", () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule",
      text: "During Second Review, run the tests and verify the ticket's functionality.",
      scope: "repo",
      repo: REPO,
      confidence: 0.67,
      source: "user_correction",
    });

    const result = compileContext(db, {
      repo: REPO,
      config: { confidence_threshold: 0.68 },
    });

    expect(result.text).toBe("");
    expect(result.confidence_threshold).toBe(0.68);
    expect(result.near_misses?.map((m) => m.confidence)).toEqual([0.67]);
    expect(result.near_misses?.[0]?.text).toContain("Second Review");
  });

  it("returns the same memory once the gate drops to where it was advertised", () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule",
      text: "During Second Review, run the tests and verify the ticket's functionality.",
      scope: "repo",
      repo: REPO,
      confidence: 0.67,
      source: "user_correction",
    });

    const result = compileContext(db, {
      repo: REPO,
      config: { confidence_threshold: 0.6 },
    });

    expect(result.text).toContain("Second Review");
    expect(result.confidence_threshold).toBe(0.6);
    expect(result.near_misses).toEqual([]);
  });

  it("an explicit threshold of 0 is honoured rather than treated as absent", async () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule",
      text: "Prefer pnpm over npm in this repo.",
      scope: "repo",
      repo: REPO,
      confidence: 0.2,
      source: "user_correction",
    });

    // 0 is falsy; the MCP layer used to drop it and silently fall back to the
    // adaptive gate, so the caller got the opposite of what they asked for.
    const result = await compileContextHybrid(db, {
      repo: REPO,
      query_text: "which package manager should I use",
      config: { confidence_threshold: 0, include_candidates: true },
    });

    expect(result.confidence_threshold).toBe(0);
  });
});

// Regression: every rejection was treated as a human "never capture this
// again" verdict, including the majority that carried no audit row at all.
// That permanently blocked re-teaching rules nobody had rejected by hand.
describe("only a human rejection blocks re-capture", () => {
  it("re-teaches a rule whose rejection nobody attributed", async () => {
    process.env.RECALL_LLM_CAPTURE_DISABLED = "true";
    const db = freshDb();

    const first = await processCorrection(db, "always run the linter before pushing", {
      sessionId: "s1",
      repo: REPO,
    });
    expect(first.ids).toHaveLength(1);

    // Unattributed: exactly the shape most rejections had in the wild.
    rejectMemory(db, first.ids[0]!);

    const second = await processCorrection(db, "always run the linter before pushing", {
      sessionId: "s2",
      repo: REPO,
    });
    expect(second.ids).toHaveLength(1);
    expect(second.blockedByRejectedExemplar ?? 0).toBe(0);
  });

  it("still refuses to re-capture something the user rejected by hand", async () => {
    process.env.RECALL_LLM_CAPTURE_DISABLED = "true";
    const db = freshDb();

    const first = await processCorrection(db, "always squash merge every branch", {
      sessionId: "s1",
      repo: REPO,
    });
    rejectMemory(db, first.ids[0]!, "cli");

    const second = await processCorrection(db, "always squash merge every branch", {
      sessionId: "s2",
      repo: REPO,
    });
    expect(second.ids).toHaveLength(0);
    // The caller must be able to tell this apart from "nothing detected".
    expect(second.blockedByRejectedExemplar).toBeGreaterThan(0);
  });

  it("ignores a machine rejection even when a human row exists for another action", async () => {
    process.env.RECALL_LLM_CAPTURE_DISABLED = "true";
    const db = freshDb();

    const first = await processCorrection(db, "never commit secrets to the repo", {
      sessionId: "s1",
      repo: REPO,
    });
    const memoryId = first.ids[0]!;
    rejectMemory(db, memoryId, "maintenance:lifecycle");
    // A human edited it once; that is not a rejection and must not block.
    recordAudit(db, memoryId, "edited", "cli", "user edited wording");

    const second = await processCorrection(db, "never commit secrets to the repo", {
      sessionId: "s2",
      repo: REPO,
    });
    expect(second.ids).toHaveLength(1);
  });

  it("records provenance on every rejection so the decision is auditable", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "rule",
      text: "Some rule that will be retired.",
      scope: "repo",
      repo: REPO,
      confidence: 0.8,
      source: "user_correction",
    });

    rejectMemory(db, id, "maintenance:lifecycle");

    const rows = db.$client
      .prepare("SELECT actor FROM audit_trail WHERE memory_id = ? AND action = 'rejected'")
      .all(id) as { actor: string }[];
    expect(rows.map((r) => r.actor)).toContain("maintenance:lifecycle");
  });
});

// Regression: an explicit capture_correction call must never silently store
// nothing. The regex extractor could produce a single unusable fragment (e.g.
// "must assess the ..." with its subject stripped), which satisfied the
// "did we find anything" check, suppressed the explicit-capture fallback, and
// was then discarded by the quality filter. The user was told "no correction
// pattern detected" for a rule they had stated three different ways.
describe("an explicit capture is never silently dropped", () => {
  const phrasings: [string, string][] = [
    [
      "declarative",
      "The purpose of a 2nd review is to assess the functional requirements of the ticket: are we actually solving the underlying problem, and do we understand how the user would interact with it and why.",
    ],
    [
      "imperative",
      "Always treat a 2nd review as a functional review, not a code review. Assess whether we are actually solving the underlying problem.",
    ],
    [
      "corrective",
      "No, that's wrong. Don't treat 2nd review as a code/technical review. From now on, a 2nd review must assess the functional requirements of the ticket.",
    ],
  ];

  for (const [label, text] of phrasings) {
    it(`captures the ${label} phrasing of the same rule`, async () => {
      process.env.RECALL_LLM_CAPTURE_DISABLED = "true";
      const db = freshDb();
      const result = await processCorrection(db, text, {
        sessionId: "s1",
        repo: REPO,
        force_semantic_capture: true,
      });
      expect(result.ids.length).toBeGreaterThan(0);
      expect(result.blockedByRejectedExemplar ?? 0).toBe(0);
    });
  }

  it("stores the forced fallback as a candidate, not an active rule", async () => {
    process.env.RECALL_LLM_CAPTURE_DISABLED = "true";
    const db = freshDb();
    // Declarative phrasing the regex extractor produces nothing usable for.
    const result = await processCorrection(
      db,
      "The purpose of a 2nd review is to assess the functional requirements of the ticket.",
      { sessionId: "s1", repo: REPO, force_semantic_capture: true },
    );
    const stored = getMemory(db, result.ids[0]!);
    // Confirmation still has to earn activation; the safety net must not be a
    // back door for promoting unvetted text.
    expect(stored?.status).toBe("candidate");
    expect(stored?.confidence).toBeLessThan(0.6);
  });

  it("still captures nothing for ambient text with no explicit capture call", async () => {
    process.env.RECALL_LLM_CAPTURE_DISABLED = "true";
    const db = freshDb();
    // No force_semantic_capture: this is passive prompt scanning, where the
    // quality filter must still throw junk away rather than store paragraphs.
    const result = await processCorrection(
      db,
      "The purpose of a 2nd review is to assess the functional requirements of the ticket.",
      { sessionId: "s1", repo: REPO },
    );
    expect(result.ids).toHaveLength(0);
  });
});

// Regression: reactivateMemory existed but nothing called it — no MCP tool, no
// CLI command. A rule rejected in error was therefore unreachable through
// every surface, which is how a team convention stayed lost while the user
// kept trying to teach it again.
describe("a rejected memory can be recovered", () => {
  const evidence = {
    type: "session_correction" as const,
    session: "test",
    timestamp: new Date().toISOString(),
    context: "user asked for this rule back",
  };

  it("restores a rejected memory as a candidate", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "rule",
      text: "Treat a second review as a functional review, not a code review.",
      scope: "repo",
      repo: REPO,
      confidence: 0.99,
      source: "user_correction",
    });
    rejectMemory(db, id, "cli");
    expect(getMemory(db, id)?.status).toBe("rejected");

    expect(reactivateMemory(db, id, evidence)).toBe(true);
    const restored = getMemory(db, id);
    // Deliberately a candidate: recovery is not a back door to an active rule.
    expect(restored?.status).toBe("candidate");
  });

  it("refuses when an active memory already covers the same rule", () => {
    const db = freshDb();
    const text = "Always rebase before merging.";
    const id = createMemory(db, {
      type: "rule", text, scope: "repo", repo: REPO,
      confidence: 0.9, source: "user_correction",
    });
    rejectMemory(db, id, "cli");
    createMemory(db, {
      type: "rule", text, scope: "repo", repo: REPO,
      confidence: 0.9, source: "user_correction",
    });

    expect(reactivateMemory(db, id, evidence)).toBe(false);
  });

  it("does nothing for a memory that was never rejected", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "rule", text: "Prefer const over let.", scope: "repo", repo: REPO,
      confidence: 0.9, source: "user_correction",
    });
    expect(reactivateMemory(db, id, evidence)).toBe(false);
  });
});
