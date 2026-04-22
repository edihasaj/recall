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
      agents: [],
      upgrade: { available: false, reasons: [] },
    });

    expect(text).toContain("# Recall Doctor");
    expect(text).toContain("DB ver:    2/2");
    expect(text).toContain("Dims:      index=512 canonical=768");
    expect(text).toContain("Launchd:   installed / loaded (running)");
  });

  it("marks agents with missing wiring and suggests --fix", () => {
    const text = formatDoctorReport({
      db_path: "/tmp/recall.db",
      db_user_version: 2,
      db_target_version: 2,
      embeddings: null,
      launchd: null,
      agents: [
        {
          agent: "claude-code",
          detected: true,
          mcp: true,
          hooks: false,
          config_path: "/home/u/.claude/settings.json",
          notes: ["No Recall-managed hooks found in settings.json"],
        },
        {
          agent: "codex",
          detected: true,
          mcp: true,
          hooks: true,
          config_path: "/home/u/.codex/config.toml",
          hook_path: "/home/u/.codex/hooks.json",
          notes: [],
        },
      ],
      upgrade: {
        available: true,
        reasons: [
          "claude-code: MCP configured but lifecycle hooks missing — memory injection depends on the model calling query",
        ],
      },
    });
    expect(text).toMatch(/claude-code\s+mcp:ok hooks:MISSING/);
    expect(text).toMatch(/codex\s+mcp:ok hooks:ok/);
    expect(text).toContain("Upgrade available");
    expect(text).toContain("recall doctor --fix");
  });

  it("calls out a legacy notify bridge in the upgrade section", () => {
    const text = formatDoctorReport({
      db_path: "/tmp/recall.db",
      db_user_version: 2,
      db_target_version: 2,
      embeddings: null,
      launchd: null,
      agents: [
        {
          agent: "codex",
          detected: true,
          mcp: true,
          hooks: false,
          legacy_notify_bridge: true,
          config_path: "/home/u/.codex/config.toml",
          hook_path: "/home/u/.codex/hooks.json",
          notes: ["Legacy notify bridge present — install the new hooks.json path"],
        },
      ],
      upgrade: {
        available: true,
        reasons: ["codex: legacy notify bridge detected — upgrade to hooks.json"],
      },
    });
    expect(text).toContain("(legacy notify bridge)");
    expect(text).toContain("legacy notify bridge");
  });
});
