import { describe, expect, it } from "vitest";
import { formatDoctorReport } from "../src/doctor/report.js";

describe("doctor report", () => {
  it("formats embedding and launchd details", () => {
    const text = formatDoctorReport({
      db_path: "/tmp/recall.db",
      db_user_version: 2,
      db_target_version: 2,
      embeddings: {
        provider: "nomic",
        model: "nomic-ai/nomic-embed-text-v1.5",
        dimensions: 512,
        canonical_dimensions: 768,
        index_dimensions: 512,
        version: "v1",
        cache_path: "/tmp/models",
        cached: true,
        size_bytes: 1024,
        size_label: "1.0 KB",
      },
      launchd: {
        installed: true,
        loaded: true,
        state: "running",
      },
    });

    expect(text).toContain("# Recall Doctor");
    expect(text).toContain("DB ver:    2/2");
    expect(text).toContain("Dims:      index=512 canonical=768");
    expect(text).toContain("Launchd:   installed / loaded (running)");
  });
});
