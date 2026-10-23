import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectRunProvenance, LongMemEvalReporter, summarizeRetrieval } from "../benchmark/longmemeval-report.js";

const metadata = {
  selected_question_ids: ["q1", "q2"],
  dataset_sha256: "dataset",
  harness_sha256: "harness",
  runtime: { node_version: "v22", platform: "darwin", arch: "arm64" },
  cache_embeddings: true,
  provenance: {
    source_files_sha256: { "src/example.ts": "source" },
    source_manifest_sha256: "manifest",
    runtime_assets_sha256: "runtime-assets",
    package_lock_sha256: "lock",
    effective_env: { RECALL_FTS_MODE: "or" },
  },
};
const provider = { provider: "multilingual-e5", model: "fixture", dimensions: 384, index_dimensions: 384, version: "v1" };
const resolvedConfig = { ...provider, similarity_threshold: 0 };
const cache = { hits: 2, misses: 3, entries: 3 };

describe("LongMemEval report", () => {
  it("summarizes retrieval metrics and groups question types", () => {
    const report = summarizeRetrieval([
      { question_id: "q1", question_type: "a", recall_any_at_5: 1, recall_any_at_10: 1, recall_any_at_20: 1, ndcg_at_10: 1, mrr: 1 },
      { question_id: "q2", question_type: "b", recall_any_at_5: 0, recall_any_at_10: 1, recall_any_at_20: 1, ndcg_at_10: .5, mrr: .5 },
    ], provider, true, cache, 7);
    expect(report.summary.recall_any_at_5).toBe(50);
    expect(report.summary.mrr).toBe(75);
    expect(Object.keys(report.by_type)).toEqual(["a", "b"]);
  });

  it("atomically reserves running artifacts before appending records and completing", () => {
    const out = join(mkdtempSync(join(tmpdir(), "lme-report-")), "result.json");
    const reporter = new LongMemEvalReporter(out, metadata, { hits: 0, misses: 0, entries: 0 });
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
      status: "running", selected_question_ids: ["q1", "q2"], source_count: 0,
    });
    expect(() => new LongMemEvalReporter(out, metadata, cache)).toThrow("already exists");
    reporter.setProvider(provider, resolvedConfig);
    reporter.record({ question_id: "q1" }, 1, 48, cache);
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
      status: "running", source_count: 48, last_question_id: "q1",
      provenance: metadata.provenance,
      resolved_embedding_config: resolvedConfig,
    });
    expect(readFileSync(`${out}.jsonl`, "utf8")).toBe('{"question_id":"q1"}\n');
    reporter.complete({ status: "complete", selected_question_ids: metadata.selected_question_ids }, 48, cache);
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ status: "complete" });
    expect(JSON.parse(readFileSync(`${out}.progress.json`, "utf8"))).toMatchObject({ status: "complete" });
  });

  it("records only allowlisted environment choices and sorted source hashes", () => {
    const root = mkdtempSync(join(tmpdir(), "lme-provenance-"));
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    mkdirSync(join(root, "benchmark"));
    writeFileSync(join(root, "src", "z.ts"), "export const z = 1;\n");
    writeFileSync(join(root, "src", "nested", "a.ts"), "export const a = 1;\n");
    mkdirSync(join(root, "src", "data"), { recursive: true });
    writeFileSync(join(root, "src", "data", "runtime.json"), '{"version":1}\n');
    writeFileSync(join(root, "src", "data", "runtime.sql"), "select 1;\n");
    for (const path of [
      "longmemeval.ts",
      "document-embedding-cache.ts",
      "longmemeval-report.ts",
      "longmemeval-source-identity.ts",
    ]) {
      writeFileSync(join(root, "benchmark", path), `export const name = "${path}";\n`);
    }
    writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
    mkdirSync(join(root, "benchmark", "data"), { recursive: true });
    writeFileSync(join(root, "benchmark", "data", "outside.json"), '{"ignored":true}\n');
    const override = join(root, "synonyms.override.json");
    writeFileSync(override, '{"groups":[["sail","boat"]]}\n');
    const provenance = collectRunProvenance(root, {
      RECALL_FTS_MODE: "or",
      RECALL_HYBRID_MIN_SIM: "0",
      RECALL_SYNONYMS_PATH: override,
      DGX_KEY: "must-not-appear",
    });
    expect(Object.keys(provenance.source_files_sha256)).toEqual([
      "benchmark/document-embedding-cache.ts",
      "benchmark/longmemeval-report.ts",
      "benchmark/longmemeval-source-identity.ts",
      "benchmark/longmemeval.ts",
      "src/nested/a.ts",
      "src/data/runtime.json",
      "src/data/runtime.sql",
      "src/z.ts",
    ].sort());
    expect(provenance.effective_env).toMatchObject({
      RECALL_FTS_MODE: "or", RECALL_HYBRID_MIN_SIM: "0",
    });
    expect(JSON.stringify(provenance)).not.toContain("must-not-appear");
    expect(provenance.synonym_override).toMatchObject({ path: override, status: "readable" });
    const initialManifest = provenance.source_manifest_sha256;
    const initialAssets = provenance.runtime_assets_sha256;
    writeFileSync(join(root, "src", "data", "runtime.json"), '{"version":2}\n');
    const jsonChanged = collectRunProvenance(root, { RECALL_SYNONYMS_PATH: override });
    expect(jsonChanged.source_manifest_sha256).not.toBe(initialManifest);
    writeFileSync(override, '{"groups":[["sail","vessel"]]}\n');
    const overrideChanged = collectRunProvenance(root, { RECALL_SYNONYMS_PATH: override });
    expect(overrideChanged.source_manifest_sha256).toBe(jsonChanged.source_manifest_sha256);
    expect(overrideChanged.runtime_assets_sha256).not.toBe(jsonChanged.runtime_assets_sha256);
    expect(overrideChanged.source_files_sha256).not.toHaveProperty("benchmark/data/outside.json");
    const missing = collectRunProvenance(root, { RECALL_SYNONYMS_PATH: join(root, "missing.json") });
    expect(missing.synonym_override).toEqual({
      path: join(root, "missing.json"), sha256: null, status: "unreadable_or_missing",
    });
  });
});
