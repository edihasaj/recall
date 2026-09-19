import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { initStandaloneDb } from "../src/db/client.js";
import { createMemory } from "../src/models/memory.js";
import { bootstrapEmbeddings, loadEmbeddingConfigFromEnv, semanticSearch, verifyEmbeddings } from "../src/embeddings/embeddings.js";
import { load } from "../src/vector/native-extension.js";

// Opt-in: this runs the real Nomic model (about 140 MB), not a provider mock.
it.skipIf(process.env.RECALL_TEST_REAL_EMBEDDINGS !== "true")(
  "persists real embeddings and retrieves them through the native vector extension",
  async () => {
    const file = join(mkdtempSync(join(tmpdir(), "recall-native-embedding-")), "recall.db");
    const db = initStandaloneDb(file);
    try {
      vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "true");
      vi.stubEnv("RECALL_EMBEDDING_PROVIDER", "nomic");
      vi.stubEnv("RECALL_EMBEDDING_MODEL", "nomic-ai/nomic-embed-text-v1.5");
      vi.stubEnv("RECALL_EMBEDDING_DIMS", "512");
      // Exercise native ranking independently of the product's score cutoff.
      vi.stubEnv("RECALL_SIMILARITY_THRESHOLD", "0");
      const repo = "fixture/native-embedding";
      const desired = createMemory(db, { repo, type: "rule", scope: "repo", source: "user_correction", confidence: 0.9,
        text: "Use uv to manage Python dependencies and virtual environments." });
      createMemory(db, { repo, type: "rule", scope: "repo", source: "user_correction", confidence: 0.9,
        text: "Use amber backgrounds and serif typography in the dashboard." });
      createMemory(db, { repo: "fixture/other", type: "rule", scope: "repo", source: "user_correction", confidence: 0.9,
        text: "Use conda to manage Python dependencies and virtual environments." });
      vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "false");
      const config = loadEmbeddingConfigFromEnv();
      expect(config).not.toBeNull();
      expect(await bootstrapEmbeddings(db, config!)).toBe(3);
      const query = "Which tool installs packages for our Python code?";
      const matches = await semanticSearch(db, query, config!, { repo, limit: 5 });
      expect(matches[0]?.memory.id).toBe(desired);
      expect(matches[0]?.similarity).toBeGreaterThan(0.5);
      expect(matches.every(match => match.memory.repo === repo)).toBe(true);
      const coverage = verifyEmbeddings(db, config!, { repo });
      expect(coverage.stored).toBe(2);
      expect(coverage.indexed).toBe(2);
      expect(coverage.index_drift).toBe(0);
      db.$client.close();

      // Reopen persisted vectors, independently of the generating connection.
      const reopened = initStandaloneDb(file);
      try {
        load(reopened.$client);
        const again = await semanticSearch(reopened, query, config!, { repo, limit: 5 });
        expect(again[0]?.memory.id).toBe(desired);
        expect(reopened.$client.pragma("quick_check", { simple: true })).toBe("ok");
      } finally {
        reopened.$client.close();
      }
    } finally {
      if (db.$client.open) db.$client.close();
      vi.unstubAllEnvs();
    }
  },
  180_000,
);
