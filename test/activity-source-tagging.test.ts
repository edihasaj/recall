import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb, initStandaloneDb } from "../src/db/client.js";
import { listActivityEvents } from "../src/models/activity.js";
import {
  handlePromptHook,
  handleSessionStartHook,
  handleToolHook,
} from "../src/cli/hook.js";
import { tagActivitySource } from "../src/types.js";

afterEach(() => {
  closeDb();
  delete process.env.RECALL_EMBEDDINGS_DISABLED;
});

function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-source-tag-"));
  return initStandaloneDb(join(dir, "test.db"));
}

describe("activity source tagging", () => {
  it("tagActivitySource returns bare transport when no agent given", () => {
    expect(tagActivitySource("mcp")).toBe("mcp");
    expect(tagActivitySource("hook")).toBe("hook");
    expect(tagActivitySource("mcp", undefined)).toBe("mcp");
    expect(tagActivitySource("mcp", null)).toBe("mcp");
    expect(tagActivitySource("mcp", "")).toBe("mcp");
  });

  it("tagActivitySource normalizes agent name", () => {
    expect(tagActivitySource("mcp", "claude-code")).toBe("mcp:claude-code");
    expect(tagActivitySource("hook", "Codex")).toBe("hook:codex");
    expect(tagActivitySource("hook", "claude code")).toBe("hook:claude-code");
  });

  it("handlePromptHook tags prompt activity with hook:<agent>", async () => {
    const db = freshDb();
    await handlePromptHook(
      {
        session_id: "sess-tag-1",
        repo: "edihasaj/recall",
        text: "hello world",
        agent: "claude-code",
      },
      { db },
    );

    const events = listActivityEvents(db, { session_id: "sess-tag-1" });
    const prompt = events.find((e) => e.event_type === "session_event");
    expect(prompt?.source).toBe("hook:claude-code");
  });

  it("handleToolHook tags tool activity with hook:<agent>", async () => {
    const db = freshDb();
    await handleToolHook(
      {
        session_id: "sess-tag-2",
        repo: "edihasaj/recall",
        name: "Edit",
        exit_code: 0,
        agent: "codex",
      },
      { db },
    );

    const events = listActivityEvents(db, { session_id: "sess-tag-2" });
    const tool = events.find((e) => e.event_type === "session_event");
    expect(tool?.source).toBe("hook:codex");
  });

  it("handleSessionStartHook tags lifecycle events with hook:<agent>", async () => {
    const db = freshDb();
    await handleSessionStartHook(
      {
        session_id: "sess-tag-3",
        agent: "claude-code",
        repo: "edihasaj/recall",
      },
      { db },
    );

    const events = listActivityEvents(db, { session_id: "sess-tag-3" });
    const start = events.find((e) => e.event_type === "session_start");
    expect(start?.source).toBe("hook:claude-code");
  });

  it("handlePromptHook falls back to bare 'cli' when agent is not set", async () => {
    const db = freshDb();
    await handlePromptHook(
      {
        session_id: "sess-tag-4",
        repo: "edihasaj/recall",
        text: "no-agent prompt",
      },
      { db },
    );

    const events = listActivityEvents(db, { session_id: "sess-tag-4" });
    expect(events.every((e) => e.source === "cli")).toBe(true);
  });
});
