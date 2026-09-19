import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqliteVec from "../src/vector/native-extension.js";
import { initStandaloneDb, closeDb } from "../src/db/client.js";
import { createMemory } from "../src/models/memory.js";
import { compileContextHybrid } from "../src/compiler/context.js";
import { getEmbeddingUnavailableReason, loadEmbeddingConfigFromEnv } from "../src/embeddings/embeddings.js";
import { removeMemoryVecRow } from "../src/vector/sqlite-vec.js";
import { removeHistoryVecRow } from "../src/vector/sqlite-vec-history.js";

vi.mock("../src/vector/native-extension.js", () => ({
  getLoadablePath: vi.fn(() => { throw new Error("Unsupported platform for sqlite-vec: win32-arm64"); }),
  load: vi.fn(() => { throw new Error("native extension must not be loaded"); }),
}));

afterEach(() => { closeDb(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("unavailable vector extension", () => {
  it("keeps memory capture and relevant lexical retrieval working", async () => {
    vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "false");
    expect(loadEmbeddingConfigFromEnv()).toBeNull();
    expect(getEmbeddingUnavailableReason()).toContain("lexical retrieval remains enabled");
    const db = initStandaloneDb(join(mkdtempSync(join(tmpdir(), "recall-no-vector-")), "recall.db"));
    const id = createMemory(db, { repo: "fixture/vector", type: "rule", scope: "repo", source: "user_correction", confidence: 0.9,
      text: "Always use uv for Python dependencies." });
    const context = await compileContextHybrid(db, { repo: "fixture/vector", query_text: "uv Python dependencies" });
    expect(context.memories_included).toContain(id);
    expect(context.text).toContain("Always use uv");
    expect(() => removeMemoryVecRow(db, id)).not.toThrow();
    expect(() => removeHistoryVecRow(db, "absent")).not.toThrow();
    expect(sqliteVec.load).not.toHaveBeenCalled();
  });
});
