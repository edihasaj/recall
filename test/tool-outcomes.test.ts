import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import { queryMemories } from "../src/models/memory.js";
import { handleToolHook } from "../src/cli/hook.js";
import {
  commandSignature,
  isUnavailableFailure,
  toolOutcomeFromPayload,
} from "../src/feedback/tool-outcomes.js";

beforeEach(() => {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
});

let counter = 0;
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "recall-tool-outcomes-"));
  return initStandaloneDb(join(dir, `t-${counter++}.db`));
}

const MISSING = "Exit code 1\n ERR_PNPM_NO_SCRIPT  Missing script: docs:list";

describe("commandSignature", () => {
  it.each([
    ["pnpm docs:list", "pnpm docs:list"],
    ["pnpm docs:list 2>/dev/null || true", "pnpm docs:list"],
    ["npm run docs:list --silent", "npm run docs:list"],
    ["CI=1 npm test -- --watch=false", "npm test"],
    ["make deploy ENV=prod", "make deploy"],
    ["uv run pytest -q", "uv run pytest"],
    ["python -m pytest tests", "python -m pytest"],
    ["/usr/local/bin/docs-list", "docs-list"],
    ["cd web && pnpm build", "pnpm build"],
  ])("%s -> %s", (command, signature) => {
    expect(commandSignature(command)).toBe(signature);
  });
});

describe("isUnavailableFailure", () => {
  it("recognises a missing command, not a failing one", () => {
    expect(isUnavailableFailure(MISSING)).toBe(true);
    expect(isUnavailableFailure("npm error Missing script: \"lint\"")).toBe(true);
    expect(isUnavailableFailure("zsh: command not found: docs-list")).toBe(true);
    expect(isUnavailableFailure("make: *** No rule to make target `deploy'.  Stop.")).toBe(true);
    expect(isUnavailableFailure("Exit code 1\nFAIL src/app.test.ts\n  1 failed")).toBe(false);
    expect(isUnavailableFailure(undefined)).toBe(false);
  });
});

describe("toolOutcomeFromPayload", () => {
  it("reads Claude Code's PostToolUseFailure exit code", () => {
    expect(toolOutcomeFromPayload({ hook_event_name: "PostToolUseFailure", error: "Exit code 127\nnot found" }))
      .toEqual({ exit_code: 127, error: "Exit code 127\nnot found" });
  });

  it("reads Codex responses as text or fields, and treats success as 0", () => {
    expect(toolOutcomeFromPayload({ tool_response: "Chunk ID: x\nProcess exited with code 1\nMissing script" }).exit_code).toBe(1);
    expect(toolOutcomeFromPayload({ tool_response: { exit_code: 2, stderr: "boom" } })).toEqual({ exit_code: 2, error: "boom" });
    expect(toolOutcomeFromPayload({ hook_event_name: "PostToolUse", tool_response: { stdout: "ok" } })).toEqual({ exit_code: 0 });
  });
});

describe("learning from tool outcomes", () => {
  const run = (db: ReturnType<typeof freshDb>, session: string, command: string, exit_code: number, error?: string) =>
    handleToolHook({ name: "Bash", repo: "acme/web", session_id: session, input_summary: command, exit_code, error }, { db });
  const learned = (db: ReturnType<typeof freshDb>) =>
    queryMemories(db, { repo: "acme/web" }).filter((m) => m.source === "tool_outcome");

  it("learns a command that is missing in two sessions, then retires it once it works", async () => {
    const db = freshDb();
    await run(db, "s1", "pnpm docs:list", 1, MISSING);
    expect(learned(db)).toHaveLength(0);

    await run(db, "s2", "pnpm docs:list 2>/dev/null", 1, MISSING);
    const [memory] = learned(db);
    expect(memory.type).toBe("gotcha");
    expect(memory.status).toBe("active");
    expect(memory.text).toContain("`pnpm docs:list` does not work in this repo");

    await run(db, "s3", "pnpm docs:list", 1, MISSING);
    expect(learned(db)[0].evidence).toHaveLength(2);

    await run(db, "s4", "pnpm docs:list", 0);
    expect(learned(db).every((m) => m.status === "rejected")).toBe(true);
  });

  it("ignores ordinary failures and repeats within one session", async () => {
    const db = freshDb();
    await run(db, "s1", "pnpm test", 1, "Exit code 1\nFAIL src/a.test.ts");
    await run(db, "s2", "pnpm test", 1, "Exit code 1\nFAIL src/a.test.ts");
    await run(db, "s3", "make deploy", 2, "make: *** No rule to make target `deploy'.");
    await run(db, "s3", "make deploy", 2, "make: *** No rule to make target `deploy'.");
    expect(learned(db)).toHaveLength(0);
  });

  it("starts counting again after the command succeeds", async () => {
    const db = freshDb();
    await run(db, "s1", "npm run lint", 1, "npm error Missing script: \"lint\"");
    await run(db, "s2", "npm run lint", 0);
    await run(db, "s3", "npm run lint", 1, "npm error Missing script: \"lint\"");
    expect(learned(db)).toHaveLength(0);
  });
});
