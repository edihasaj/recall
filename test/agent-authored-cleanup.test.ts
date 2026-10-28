import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { initStandaloneDb } from "../src/db/client.js";
import { createMemory, getMemory } from "../src/models/memory.js";
import { createCodexRolloutLocator } from "../src/cli/codex-thread-origin.js";
import { planRejectAgentAuthored } from "../src/maintenance/agent-authored.js";
import { revertCleanupRun, runDeterministicCleanup } from "../src/maintenance/cleanup.js";
import type { EvidenceEntry } from "../src/types.js";

const STARTED = "2026-10-22T11:22:16.000Z";
let codexHome = "";
const openDbs: ReturnType<typeof initStandaloneDb>[] = [];

beforeEach(() => {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  codexHome = mkdtempSync(join(tmpdir(), "recall-codex-home-"));
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  for (const db of openDbs.splice(0)) db.$client.close();
  delete process.env.CODEX_HOME;
  delete process.env.RECALL_EMBEDDINGS_DISABLED;
});

function freshDb() {
  const db = initStandaloneDb(join(mkdtempSync(join(tmpdir(), "recall-agent-authored-")), "recall.db"));
  openDbs.push(db);
  return db;
}

/** Writes a rollout for a new thread; `archived` uses the flat archive directory. */
function thread(source: unknown, opts: { archived?: boolean } = {}): string {
  const id = randomUUID();
  const day = new Date(STARTED);
  const dir = opts.archived
    ? join(codexHome, "archived_sessions")
    : join(codexHome, "sessions", String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const meta = { timestamp: STARTED, type: "session_meta", payload: { id, source } };
  writeFileSync(join(dir, `rollout-2026-10-22T13-22-16-${id}.jsonl`), `${JSON.stringify(meta)}\n{}\n`);
  return id;
}

const correction = (session: string): EvidenceEntry => ({
  type: "session_correction",
  session,
  timestamp: STARTED,
  context: "brief",
});

function rule(db: ReturnType<typeof freshDb>, text: string, evidence: Array<EvidenceEntry & { sessions?: string[] }>) {
  return createMemory(db, {
    type: "rule",
    text,
    scope: "repo",
    repo: "acme/app",
    source: "user_correction",
    confidence: 0.7,
    evidence: evidence as EvidenceEntry[],
  });
}

describe("reject_agent_authored cleanup", () => {
  it("rejects only rules whose every source session is an automated Codex thread", () => {
    const db = freshDb();
    const exec = thread("exec");
    const sub = thread({ subagent: { thread_spawn: { depth: 1 } } }, { archived: true });
    const desktop = thread("vscode");

    const brief = rule(db, "Do not use uv for this worker", [
      correction(exec),
      { type: "repeated_correction", timestamp: STARTED, sessions: [sub] } as EvidenceEntry & { sessions: string[] },
    ]);
    const mixed = rule(db, "Use pnpm for package commands", [correction(exec), correction(desktop)]);
    const remote = rule(db, "Keep releases signed", [correction(randomUUID())]);
    const confirmed = rule(db, "Reply with the model name", [
      correction(exec),
      { type: "session_correction", session: "cli", timestamp: STARTED, context: "user explicitly confirmed" },
    ]);

    const plan = planRejectAgentAuthored(db, { locate: createCodexRolloutLocator(codexHome) });
    expect(plan.map((item) => item.memory_id)).toEqual([brief]);
    expect(plan[0]?.sessions.map((s) => s.source).sort()).toEqual(["exec", "subagent"]);

    const report = runDeterministicCleanup(db, { dryRun: false, only: "reject_agent_authored" });
    expect(report.counts.agent_authored_rejections).toBe(1);
    expect(getMemory(db, brief)?.status).toBe("rejected");
    for (const kept of [mixed, remote, confirmed]) expect(getMemory(db, kept)?.status).not.toBe("rejected");

    expect(revertCleanupRun(db, report.run_id).reverted).toBe(1);
    expect(getMemory(db, brief)?.status).not.toBe("rejected");
  });

  it("keeps rules whose source session is not a Codex thread id", () => {
    const db = freshDb();
    rule(db, "Use the validated gateway host", [correction("mcp:codex-mcp-client-capture")]);
    let calls = 0;
    const plan = planRejectAgentAuthored(db, { locate: (id) => { calls += 1; return createCodexRolloutLocator(codexHome)(id); } });
    expect(plan).toEqual([]);
    expect(calls).toBe(1);
  });
});
