import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import { processCorrection, detectCorrections } from "../src/capture/correction.js";
import { getMemory } from "../src/models/memory.js";
import { inferScope } from "../src/capture/scope.js";
import { handlePromptHook } from "../src/cli/hook.js";
import { listActivityEvents } from "../src/models/activity.js";

let dbCounter = 0;

function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-memory-quality-p2-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

describe("memory quality phase 2 rich context", () => {
  it("persists capture_context and improves scope inference from recent tool calls", async () => {
    const db = freshDb();
    const ids = await processCorrection(db, "always use the correct pattern here", {
      sessionId: "sess-1",
      repo: "edihasaj/recall",
      agent: "codex",
      prev_assistant_turn: "Edit src/components/Button.tsx to use inline styles.",
      recent_tool_calls: [
        {
          name: "Edit",
          path: "src/components/Button.tsx",
          exit_code: 0,
        },
      ],
    });

    expect(ids).toHaveLength(1);
    const memory = getMemory(db, ids[0])!;
    expect(memory.scope).toBe("path");
    expect(memory.path_scope).toContain("src/components");
    expect(memory.capture_context?.agent).toBe("codex");
    expect(memory.capture_context?.prev_assistant_text).toContain("Button.tsx");
    expect(memory.capture_context?.recent_tool_calls?.[0].path).toBe("src/components/Button.tsx");
  });

  it("inferScope can use assistant/tool context when text is generic", () => {
    const result = inferScope(
      "use the correct approach",
      undefined,
      undefined,
      {
        prev_assistant_turn: "Update src/api/routes.ts to use the older pattern.",
        recent_tool_calls: [{ name: "Edit", path: "src/api/routes.ts", exit_code: 0 }],
      },
    );

    expect(result.scope).toBe("path");
    expect(result.path_scope).toContain("src/api");
    expect(result.reason).toContain("recent tool path context");
  });

  it("hook prompt captures correction-shaped prompts through the same fallback path", async () => {
    const db = freshDb();
    expect(detectCorrections("don't use pip, use uv")).toHaveLength(1);

    await handlePromptHook(
      {
        session_id: "sess-2",
        repo: "edihasaj/recall",
        text: "don't use pip, use uv",
        agent: "codex",
        prev_assistant_turn: "Run pip install -e .",
        recent_tool_calls: [
          {
            name: "shell",
            input_summary: "pip install -e .",
            exit_code: 0,
          },
        ],
      },
      { db, source: "cli" },
    );

    const correctionEvents = listActivityEvents(db, {
      session_id: "sess-2",
      event_type: "correction",
    });
    expect(correctionEvents).toHaveLength(1);
    expect(correctionEvents[0].request.prev_assistant_turn).toBe("Run pip install -e .");

    const createdId = correctionEvents[0].memory_ids[0]!;
    const memory = getMemory(db, createdId)!;
    expect(memory.capture_context?.prev_assistant_text).toBe("Run pip install -e .");
    expect(memory.capture_context?.agent).toBe("codex");
  });

  it("hook prompt dedupes repeated prompt and correction activity", async () => {
    const db = freshDb();
    const input = {
      session_id: "sess-dup",
      repo: "edihasaj/recall",
      text: "don't use pip, use uv",
      agent: "codex",
      prev_assistant_turn: "Run pip install -e .",
      recent_tool_calls: [
        {
          name: "shell",
          input_summary: "pip install -e .",
          exit_code: 0,
        },
      ],
    } as const;

    await handlePromptHook(input, { db, source: "cli" });
    await handlePromptHook(input, { db, source: "cli" });

    expect(listActivityEvents(db, {
      session_id: "sess-dup",
      event_type: "session_event",
    })).toHaveLength(1);
    expect(listActivityEvents(db, {
      session_id: "sess-dup",
      event_type: "correction",
    })).toHaveLength(1);
  });
});
