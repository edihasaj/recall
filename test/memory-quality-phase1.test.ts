import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import { createMemory, getMemory } from "../src/models/memory.js";

let dbCounter = 0;

function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-memory-quality-p1-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

describe("memory quality phase 1 schema", () => {
  it("persists capture_context on memories", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "rule",
      text: "Use uv",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.45,
      capture_context: {
        prev_assistant_text: "Use pip install recall",
        recent_tool_calls: [
          {
            name: "shell",
            path: "pyproject.toml",
            exit_code: 0,
          },
        ],
        repo: "edihasaj/recall",
        path: "pyproject.toml",
        agent: "codex",
      },
    });

    const memory = getMemory(db, id)!;
    expect(memory.capture_context).toEqual({
      prev_assistant_text: "Use pip install recall",
      recent_tool_calls: [
        {
          name: "shell",
          path: "pyproject.toml",
          exit_code: 0,
        },
      ],
      repo: "edihasaj/recall",
      path: "pyproject.toml",
      agent: "codex",
    });
  });

  it("creates the memory_injections table in migrated databases", () => {
    const db = freshDb();
    const rows = db.$client
      .prepare("select name from sqlite_master where type = 'table' and name = 'memory_injections'")
      .all() as Array<{ name: string }>;

    expect(rows).toEqual([{ name: "memory_injections" }]);
  });

  it("creates the memory_value_events table in migrated databases", () => {
    const db = freshDb();
    const rows = db.$client
      .prepare("select name from sqlite_master where type = 'table' and name = 'memory_value_events'")
      .all() as Array<{ name: string }>;

    expect(rows).toEqual([{ name: "memory_value_events" }]);
  });
});
