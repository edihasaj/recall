import { existsSync, mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { initStandaloneDb } from "../src/db/client.js";
import { getAuditTrail } from "../src/audit/trail.js";
import { compileContext } from "../src/compiler/context.js";
import { rejectMemory, confirmMemory, getMemory, recordFeedback } from "../src/models/memory.js";
import { evaluatePromotionCandidates } from "../src/maintenance/promote.js";
import {
  importHarness2Experience,
  previewHarness2Experience,
  readHarness2Experience,
} from "../src/importers/harness2.js";
import { registerHarness2Commands } from "../src/cli/harness2.js";

let counter = 0;
function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const directory = mkdtempSync(join(tmpdir(), "recall-harness2-"));
  return initStandaloneDb(join(directory, `test-${counter++}.db`));
}

function fixture(content = "# Experience\r\n\r\nUse the local release checklist.\r") {
  const directory = mkdtempSync(join(tmpdir(), "recall-harness2-file-"));
  const file = join(directory, "EXPERIENCE.md");
  writeFileSync(file, `\uFEFF${content}`);
  return { directory, file };
}

function startConcurrentImport(database: string) {
  const directory = mkdtempSync(join(tmpdir(), "recall-harness2-race-"));
  const worker = join(directory, "import.ts");
  writeFileSync(worker, `
import { initStandaloneDb } from ${JSON.stringify(pathToFileURL(resolve("src/db/client.ts")).href)};
import { importHarness2Experience, previewHarness2Experience } from ${JSON.stringify(pathToFileURL(resolve("src/importers/harness2.ts")).href)};

process.env.RECALL_EMBEDDINGS_DISABLED = "true";
const db = initStandaloneDb(process.argv[2]);
process.send?.({ type: "ready" });
process.once("message", (message) => {
  if (message !== "go") return;
  try {
    const result = importHarness2Experience(db, previewHarness2Experience("Concurrent document", { repo: "edi/recall" }));
    db.$client.close();
    process.send?.({ type: "result", created: result.created, status: result.memory.status });
  } catch (error) {
    process.send?.({ type: "error", error: error instanceof Error ? error.message : String(error) });
  }
  setTimeout(() => process.exit(0), 0);
});
`);

  const child = spawn(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), worker, database], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, RECALL_EMBEDDINGS_DISABLED: "true" },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (result: { created: boolean; status: string }) => void;
  let rejectResult!: (error: Error) => void;
  const ready = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const result = new Promise<{ created: boolean; status: string }>((resolvePromise, rejectPromise) => {
    resolveResult = resolvePromise;
    rejectResult = rejectPromise;
  });
  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const event = message as { type?: string; created?: boolean; status?: string; error?: string };
    if (event.type === "ready") resolveReady();
    if (event.type === "result" && typeof event.created === "boolean" && typeof event.status === "string") {
      resolveResult({ created: event.created, status: event.status });
    }
    if (event.type === "error") rejectResult(new Error(event.error));
  });
  child.on("error", (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  child.on("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`Concurrent Harness2 importer exited ${code}: ${stderr}`);
      rejectReady(error);
      rejectResult(error);
    }
  });
  return { child, ready, result };
}

describe("Harness2 EXPERIENCE.md importer", () => {
  it("previews one normalized document without initializing a database", () => {
    const preview = previewHarness2Experience("\uFEFFa\r\nb\rc\n", {
      repo: "  edi/recall  ",
      sourceRef: "  harness2://source/1  ",
    });

    expect(preview.project).toBe("edi/recall");
    expect(preview.content).toBe("a\nb\nc");
    expect(preview.candidate).toEqual({
      type: "gotcha", scope: "repo", status: "candidate", confidence: 0.4,
      source: "tool_outcome", autoInject: false,
    });
    expect(preview.cloudImport).toMatchObject({
      provider: "harness2", project: "edi/recall", content: "a\nb\nc", sourceRef: "harness2://source/1",
    });
    expect(preview.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("keeps the CLI default as a no-database preview", () => {
    const { file } = fixture();
    const dataDir = mkdtempSync(join(tmpdir(), "recall-harness2-preview-"));
    const prior = process.env.RECALL_DATA_DIR;
    process.env.RECALL_DATA_DIR = dataDir;
    const program = new Command();
    registerHarness2Commands(program);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      program.parse(["node", "recall", "harness2", "import", file, "--repo", "edi/recall", "--json"]);
      expect(existsSync(join(dataDir, "recall.db"))).toBe(false);
      expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
        applied: false,
        memory: null,
        preview: { provider: "harness2", project: "edi/recall" },
      });
      expect(() => program.parse([
        "node", "recall", "harness2", "import", "x".repeat(2_001), "--repo", "edi/recall",
      ])).toThrow(/sourceRef.*2000/);
    } finally {
      log.mockRestore();
      if (prior === undefined) delete process.env.RECALL_DATA_DIR;
      else process.env.RECALL_DATA_DIR = prior;
    }
  });

  it("reads only a regular bounded valid UTF-8 file", () => {
    const { directory, file } = fixture();
    const read = readHarness2Experience(file, { repo: "edi/recall" });
    expect(read.content).toContain("local release");
    expect(read.sourceRef).toBe(resolve(file));
    expect(read.digest).toBe(previewHarness2Experience(read.content, {
      repo: "edi/recall", sourceRef: "harness2://other-path",
    }).digest);
    expect(readHarness2Experience(file, { repo: "edi/recall", sourceRef: "harness2://run/1" }).sourceRef).toBe("harness2://run/1");
    const link = join(directory, "link.md");
    symlinkSync(file, link);
    expect(() => readHarness2Experience(link, { repo: "edi/recall" })).toThrow();
    writeFileSync(file, Buffer.from([0xc3, 0x28]));
    expect(() => readHarness2Experience(file, { repo: "edi/recall" })).toThrow(/UTF-8/);
    expect(() => previewHarness2Experience("\0", { repo: "edi/recall" })).toThrow(/NUL/);
    expect(() => previewHarness2Experience("", { repo: "edi/recall" })).toThrow(/empty/);
    expect(() => previewHarness2Experience("x", { repo: "" })).toThrow(/--repo/);
    expect(() => previewHarness2Experience("x", { repo: "edi/\nrecall" })).toThrow(/single line/);
    expect(() => previewHarness2Experience("x".repeat(20_001), { repo: "edi/recall" })).toThrow(/20000/);
    expect(() => previewHarness2Experience("x", { repo: "edi/recall", sourceRef: "x".repeat(2_001) })).toThrow(/2000/);
    expect(() => previewHarness2Experience("\n".repeat(128 * 1024 + 1), { repo: "edi/recall" })).toThrow(/131072/);
    expect(() => previewHarness2Experience("\ud800", { repo: "edi/recall" })).toThrow(/unpaired UTF-16 surrogate/);
    expect(() => previewHarness2Experience("\udc00", { repo: "edi/recall" })).toThrow(/unpaired UTF-16 surrogate/);
  });

  it("stores generated provenance and never queues an embedding", () => {
    const db = freshDb();
    const preview = previewHarness2Experience("Keep adapter notes near the test.", {
      repo: "edi/recall", sourceRef: "harness2://runs/42",
    });
    const result = importHarness2Experience(db, preview);
    const row = getMemory(db, result.id)!;
    const review = row.evidence.find((entry) => entry.type === "review_feedback")!;
    const scan = row.evidence.find((entry) => entry.type === "repo_scan")!;

    expect(result.created).toBe(true);
    expect(row).toMatchObject({
      type: "gotcha", scope: "repo", repo: "edi/recall", status: "candidate",
      confidence: 0.4, source: "tool_outcome", auto_inject: false,
      injection_count: 0, override_count: 0, repetition_count: 0,
    });
    expect(review).toMatchObject({ reported_by_user: false, reviewer: "harness2" });
    expect(review.type === "review_feedback" && review.context).toMatch(/^<agent-response>.*experimental.*sourceRef=harness2:\/\/runs\/42.*sha256=/);
    expect(scan).toMatchObject({ file: "harness2://runs/42" });
    expect(db.$client.prepare("select count(*) as n from memory_embeddings").get()).toMatchObject({ n: 0 });
    expect(getAuditTrail(db, row.id).map((entry) => entry.action)).toEqual(["created"]);
  });

  it("is idempotent across paths and retained rejected records without touching timestamps", () => {
    const db = freshDb();
    const first = importHarness2Experience(db, previewHarness2Experience("Same document", { repo: "edi/recall", sourceRef: "first" }));
    const before = getMemory(db, first.id)!;
    rejectMemory(db, first.id, "cli");
    const rejected = getMemory(db, first.id)!;
    const duplicate = importHarness2Experience(db, previewHarness2Experience("Same document", { repo: "edi/recall", sourceRef: "copied/path" }));
    const after = getMemory(db, first.id)!;

    expect(duplicate).toMatchObject({ id: first.id, created: false });
    expect(duplicate.memory).toMatchObject({ id: first.id, status: "rejected", auto_inject: false });
    expect(after).toMatchObject({ status: "rejected", created_at: rejected.created_at, updated_at: rejected.updated_at });
    expect(after.evidence).toEqual(rejected.evidence);
    expect(getAuditTrail(db, first.id).filter((entry) => entry.action === "created")).toHaveLength(1);
    expect(before.created_at).toBe(rejected.created_at);
  });

  it("isolates documents by repo and changed content", () => {
    const db = freshDb();
    const a = importHarness2Experience(db, previewHarness2Experience("Document A", { repo: "edi/recall" }));
    const b = importHarness2Experience(db, previewHarness2Experience("Document A", { repo: "other/recall" }));
    const c = importHarness2Experience(db, previewHarness2Experience("Document B", { repo: "edi/recall" }));
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it("serializes simultaneous imports from separate database processes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "recall-harness2-concurrent-db-"));
    const database = join(directory, "recall.db");
    const bootstrap = initStandaloneDb(database);
    bootstrap.$client.close();

    const workers = [startConcurrentImport(database), startConcurrentImport(database)];
    await Promise.all(workers.map((worker) => worker.ready));
    workers.forEach((worker) => worker.child.send("go"));
    const results = await Promise.all(workers.map((worker) => worker.result));

    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(results.map((result) => result.status)).toEqual(["candidate", "candidate"]);
  });

  it("reports a retained duplicate's actual state instead of its preview", () => {
    const { file } = fixture();
    const dataDir = mkdtempSync(join(tmpdir(), "recall-harness2-cli-"));
    const prior = process.env.RECALL_DATA_DIR;
    process.env.RECALL_DATA_DIR = dataDir;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const firstProgram = new Command();
      registerHarness2Commands(firstProgram);
      firstProgram.parse(["node", "recall", "harness2", "import", file, "--repo", "edi/recall", "--apply", "--json"]);
      const first = JSON.parse(log.mock.calls[0]![0] as string);
      expect(first.preview.candidate).toMatchObject({ status: "candidate", autoInject: false });
      expect(first.memory).toMatchObject({ status: "candidate", auto_inject: false });

      const db = initStandaloneDb(join(dataDir, "recall.db"));
      expect(rejectMemory(db, first.memory.id, "cli")).toBe(true);
      log.mockClear();

      const duplicateProgram = new Command();
      registerHarness2Commands(duplicateProgram);
      duplicateProgram.parse(["node", "recall", "harness2", "import", file, "--repo", "edi/recall", "--apply"]);
      const output = log.mock.calls.map(([line]) => String(line)).join("\n");
      expect(output).toContain("status: rejected");
      expect(output).toContain(`recall reactivate ${first.memory.id}`);
      expect(output).not.toContain(`recall confirm ${first.memory.id}`);
      expect(getMemory(db, first.memory.id)).toMatchObject({ status: "rejected", auto_inject: false });
    } finally {
      log.mockRestore();
      if (prior === undefined) delete process.env.RECALL_DATA_DIR;
      else process.env.RECALL_DATA_DIR = prior;
    }
  });

  it("quarantines generated-only experience until a human confirmation", () => {
    const db = freshDb();
    const imported = importHarness2Experience(db, previewHarness2Experience("Prefer the checked-in release checklist.", { repo: "edi/recall" }));
    const before = getMemory(db, imported.id)!;

    expect(compileContext(db, { repo: "edi/recall", config: { confidence_threshold: 0 } }).text).not.toContain(before.text);
    expect(recordFeedback(db, imported.id, "session-1", true, "followed")).toBeTruthy();
    expect(getMemory(db, imported.id)?.confidence).toBe(0.4);
    expect(evaluatePromotionCandidates(db, { fragmentReasons: () => [] }).find((item) => item.memory_id === imported.id)?.decision).toBe("suppressed");

    expect(confirmMemory(db, imported.id)).toBe(true);
    expect(compileContext(db, { repo: "edi/recall", config: { confidence_threshold: 0 } }).text).toContain(before.text);
  });
});
