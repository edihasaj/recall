import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { initStandaloneDb } from "../src/db/client.js";
import { createMemory } from "../src/models/memory.js";

const tsxEntry = resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
const cliEntry = resolve(process.cwd(), "src/cli.ts");

describe("recall compile CLI value accounting", () => {
  it("persists injection and value events when --session is provided", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "recall-cli-compile-value-"));
    const db = initStandaloneDb(join(dataDir, "recall.db"));
    const memoryId = createMemory(db, {
      type: "rule",
      text: "Always use Node 22 when running Recall tests.",
      scope: "repo",
      repo: "edihasaj/recall-cli-test",
      source: "user_correction",
      confidence: 0.8,
    });

    const result = spawnSync(process.execPath, [
      tsxEntry,
      cliEntry,
      "compile",
      "-r",
      "edihasaj/recall-cli-test",
      "-s",
      "cli-session",
    ], {
      env: {
        ...process.env,
        RECALL_DATA_DIR: dataDir,
        RECALL_EMBEDDINGS_DISABLED: "true",
        RECALL_LLM_CAPTURE_DISABLED: "true",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Always use Node 22");

    const injection = db.$client
      .prepare("select memory_id, session_id from memory_injections where memory_id = ?")
      .get(memoryId) as { memory_id: string; session_id: string } | undefined;
    expect(injection).toEqual({ memory_id: memoryId, session_id: "cli-session" });

    const value = db.$client
      .prepare(
        "select event_type, session_id, injected_tokens_estimate from memory_value_events where memory_id = ?",
      )
      .get(memoryId) as { event_type: string; session_id: string; injected_tokens_estimate: number } | undefined;
    expect(value?.event_type).toBe("injected");
    expect(value?.session_id).toBe("cli-session");
    expect(value?.injected_tokens_estimate).toBeGreaterThan(0);
  });
});
