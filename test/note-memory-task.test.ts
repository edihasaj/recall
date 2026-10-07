import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initStandaloneDb } from "../src/db/client.js";
import { buildPrompt } from "../src/maintenance/dispatcher.js";
import { claimTask, listTasks, produceNoteMemoryTasks, submitTask } from "../src/maintenance/tasks.js";
import { createMemory, getMemory } from "../src/models/memory.js";
import type { MaintenanceTask } from "../src/types.js";

afterEach(() => vi.unstubAllEnvs());

function freshDb() {
  vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "true");
  return initStandaloneDb(join(mkdtempSync(join(tmpdir(), "recall-note-task-")), "recall.db"));
}

const memory = {
  repo: "fixture/notes", type: "gotcha" as const, scope: "repo" as const, source: "user_correction" as const,
  confidence: 0.9, text: "Never point load tests at staging; it has no read replicas.",
};

function noteTasks(db: ReturnType<typeof freshDb>) {
  return listTasks(db, { kinds: ["note_memory"] }) as MaintenanceTask[];
}

it("queues a note only for live memories that have none", () => {
  const db = freshDb();
  const bare = createMemory(db, memory);
  createMemory(db, { ...memory, text: "Use pnpm, not npm.", note: "installing packages" });
  expect(produceNoteMemoryTasks(db, { max_per_kind: 10 })).toBe(1);
  const [task] = noteTasks(db);
  expect(task.payload).toMatchObject({ memory_id: bare, text: memory.text });
  expect(String((task.payload as { instructions?: string }).instructions)).toContain("in the words a future request would use");
  expect(produceNoteMemoryTasks(db, { max_per_kind: 10 })).toBe(0); // idempotent while open
});

it("an agent's submitted note is stored and indexed with the memory", () => {
  const db = freshDb();
  const id = createMemory(db, memory);
  produceNoteMemoryTasks(db, { max_per_kind: 10 });
  const [task] = noteTasks(db);
  claimTask(db, task.id, "claude-code");
  const outcome = submitTask(db, task.id, "claude-code", { affects: "load tests, benchmarks, reporting jobs" });
  expect(outcome.status).toBe("applied");
  expect(getMemory(db, id)?.note).toBe("load tests, benchmarks, reporting jobs");
});

it("never overwrites a note the memory gained meanwhile, and accepts null", () => {
  const db = freshDb();
  const id = createMemory(db, memory);
  produceNoteMemoryTasks(db, { max_per_kind: 10 });
  const [task] = noteTasks(db);
  createMemory(db, { ...memory, note: "written by the capturing agent" }); // dedupes onto the same memory
  claimTask(db, task.id, "claude-code");
  expect(submitTask(db, task.id, "claude-code", { affects: "something else" }).status).toBe("applied");
  expect(getMemory(db, id)?.note).toBe("written by the capturing agent");

  const other = createMemory(db, { ...memory, text: "Prefer tabs in Makefiles." });
  produceNoteMemoryTasks(db, { max_per_kind: 10 });
  const next = noteTasks(db).find((t) => (t.payload as { memory_id?: string }).memory_id === other)!;
  claimTask(db, next.id, "claude-code");
  expect(submitTask(db, next.id, "claude-code", { affects: null }).status).toBe("applied");
  expect(getMemory(db, other)?.note).toBeNull();
});

it("the dispatcher prompt asks for affects as JSON", () => {
  const db = freshDb();
  createMemory(db, memory);
  produceNoteMemoryTasks(db, { max_per_kind: 10 });
  const prompt = buildPrompt(noteTasks(db)[0])!;
  expect(prompt.system).toContain("retrieval notes");
  expect(prompt.user).toContain('{"affects": string|null}');
  expect(prompt.user).toContain(memory.text);
});
