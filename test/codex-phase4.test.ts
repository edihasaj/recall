import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import { listActivityEvents } from "../src/models/activity.js";
import { installCodexHooks, uninstallCodexHooks } from "../src/agents/codex.js";
import { dispatchCodexNotify } from "../src/cli/hook.js";

const fixturePath = join(process.cwd(), "test", "fixtures", "codex", "config.toml");

afterEach(() => {
  delete process.env.RECALL_CLI_PATH;
  delete process.env.RECALL_NODE_PATH;
});

beforeEach(() => {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
});

describe("phase 4 Codex adapter", () => {
  it("installs a Recall-managed notify bridge into config.toml", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "recall-codex-phase4-"));
    const configDir = join(tempDir, ".codex");
    const configPath = join(configDir, "config.toml");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, readFileSync(fixturePath, "utf-8"));

    const result = installCodexHooks({
      configPath,
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
    });

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);

    const next = readFileSync(configPath, "utf-8");
    expect(next).toContain("# recall:managed:codex:start");
    expect(next).toContain('notify = ["/opt/recall/node", "/opt/recall/dist/cli.js", "hook", "codex-notify"]');

    const backupName = readdirSync(configDir).find((name) =>
      name.startsWith("config.toml.recall.bak."),
    );
    expect(backupName).toBeTruthy();
    expect(existsSync(join(configDir, backupName!))).toBe(true);

    const second = installCodexHooks({
      configPath,
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
    });
    expect(second.changed).toBe(false);
  });

  it("removes only the Recall-managed notify bridge", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "recall-codex-phase4-"));
    const configDir = join(tempDir, ".codex");
    const configPath = join(configDir, "config.toml");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, readFileSync(fixturePath, "utf-8"));

    installCodexHooks({
      configPath,
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
    });

    const result = uninstallCodexHooks({ configPath });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);

    const next = readFileSync(configPath, "utf-8");
    expect(next).not.toContain("codex-notify");
    expect(next).toContain('model = "gpt-5.4"');
    expect(next).toContain('[mcp_servers.recall]');
  });

  it("refuses to overwrite an unmanaged notify config", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "recall-codex-phase4-"));
    const configDir = join(tempDir, ".codex");
    const configPath = join(configDir, "config.toml");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, 'notify = ["terminal-notifier"]\n');

    const result = installCodexHooks({
      configPath,
      nodePath: "/opt/recall/node",
      cliPath: "/opt/recall/dist/cli.js",
    });

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(readFileSync(configPath, "utf-8")).toBe('notify = ["terminal-notifier"]\n');
  });

  it("routes Codex notify payloads into Recall session events", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "recall-codex-phase4-db-"));
    const db = initStandaloneDb(join(tempDir, "recall.db"));

    await dispatchCodexNotify(JSON.stringify({
      event: "session_start",
      session_id: "sess-1",
      cwd: "/Users/edi/Projects/recall",
    }), { db });
    await dispatchCodexNotify(JSON.stringify({
      event: "user_prompt_submit",
      session_id: "sess-1",
      cwd: "/Users/edi/Projects/recall",
      prompt: "phase 4",
    }), { db });
    await dispatchCodexNotify(JSON.stringify({
      event: "post_tool_use",
      session_id: "sess-1",
      cwd: "/Users/edi/Projects/recall",
      tool_name: "shell",
      tool_input: { command: "pnpm test" },
    }), { db });
    await dispatchCodexNotify(JSON.stringify({
      event: "stopped",
      session_id: "sess-1",
      cwd: "/Users/edi/Projects/recall",
    }), { db });

    const events = listActivityEvents(db, { session_id: "sess-1" });
    expect(events.map((event) => event.event_type).sort()).toEqual([
      "scan",
      "session_end",
      "session_event",
      "session_event",
      "session_start",
    ].sort());

    const toolEvent = events.find((event) => event.request.name === "tool_invoked");
    expect(toolEvent?.result.tool_call).toEqual({
      name: "shell",
      input_summary: "pnpm test",
      exit_code: 0,
    });
  });
});
