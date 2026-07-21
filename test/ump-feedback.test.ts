import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toAmpId } from "@universalmemoryprotocol/core/adapters/recall";
import { initStandaloneDb } from "../src/db/client.js";
import { createMemory, getMemoryFeedback } from "../src/models/memory.js";
import { createRecallUmpServer } from "../src/ump/serve.js";

let dbCounter = 0;

function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-ump-feedback-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

describe("UMP feedback", () => {
  it("records ump.feedback into Recall feedback and value telemetry", async () => {
    const db = freshDb();
    const memoryId = createMemory(db, {
      type: "rule",
      text: "Always use pnpm for package commands.",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.8,
    });

    const { server } = createRecallUmpServer(db);
    await server.feedback({
      id: toAmpId(memoryId),
      outcome: "followed",
      session: "ump-session",
    });

    const feedback = getMemoryFeedback(db, memoryId);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].outcome).toBe("followed");

    const value = db.$client
      .prepare("select event_type, source, saved_tokens_estimate from memory_value_events where session_id = ? and memory_id = ?")
      .get("ump-session", memoryId) as { event_type: string; source: string; saved_tokens_estimate: number };
    expect(value.event_type).toBe("followed");
    expect(value.source).toBe("mcp:ump");
    expect(value.saved_tokens_estimate).toBeGreaterThan(0);
  });
});
