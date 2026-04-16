import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import { createMemory, getMemoryFeedback } from "../src/models/memory.js";
import { listActivityEvents } from "../src/models/activity.js";
import {
  captureCorrectionFallback,
  sessionEndFallback,
  signalOutcomeFallback,
} from "../src/mcp/fallback.js";

let dbCounter = 0;

function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-mcp-phase5-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

describe("phase 5 MCP fallback helpers", () => {
  it("captures correction context in the activity trail", async () => {
    const db = freshDb();

    const result = await captureCorrectionFallback(db, {
      text: "don't use pip, use uv",
      repo: "edihasaj/recall",
      path: "src/mcp/server.ts",
      session_id: "sess-1",
      agent: "codex",
      prev_assistant_turn: "Use pip install",
      recent_tool_calls: [
        { name: "shell", input_summary: "pip install recall", exit_code: 0 },
      ],
    }, "mcp");

    expect(result.ids).toHaveLength(1);
    const event = listActivityEvents(db, { session_id: "sess-1", event_type: "correction" })[0];
    expect(event.request.agent).toBe("codex");
    expect(event.request.prev_assistant_turn).toBe("Use pip install");
    expect(event.request.recent_tool_calls).toEqual([
      { name: "shell", input_summary: "pip install recall", exit_code: 0 },
    ]);
  });

  it("records outcome signals through feedback storage", () => {
    const db = freshDb();
    const memoryId = createMemory(db, {
      type: "rule",
      text: "Use uv",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.45,
    });

    const result = signalOutcomeFallback(db, {
      memory_id: memoryId,
      session_id: "sess-2",
      outcome: "followed",
      context: "user accepted the uv flow",
    }, "mcp");

    expect(result.feedback_id).toBeTruthy();
    const feedback = getMemoryFeedback(db, memoryId);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].outcome).toBe("followed");
    const event = listActivityEvents(db, { session_id: "sess-2", event_type: "feedback" })[0];
    expect(event.request.context).toBe("user accepted the uv flow");
  });

  it("records session end boundaries", () => {
    const db = freshDb();

    const result = sessionEndFallback(db, {
      session_id: "sess-3",
      repo: "edihasaj/recall",
      path: "src/mcp/server.ts",
      agent: "codex",
      turn_count: 7,
    });

    expect(result.session_id).toBe("sess-3");
    const event = listActivityEvents(db, { session_id: "sess-3", event_type: "session_end" })[0];
    expect(event.result.turn_count).toBe(7);
    expect(event.request.client).toBe("codex");
  });
});
