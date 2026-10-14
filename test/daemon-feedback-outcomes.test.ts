import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { initStandaloneDb } from "../src/db/client.js";
import { createMemory } from "../src/models/memory.js";

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No test port"));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => { clearTimeout(timer); resolveStop(); });
    child.kill("SIGTERM");
  });
}

it("records real daemon feedback in the canonical injection and value ledgers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recall-feedback-http-"));
  const db = initStandaloneDb(join(dir, "recall.db"));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let output = "";
  let child: ChildProcess | undefined;
  const previousDisabled = process.env.RECALL_EMBEDDINGS_DISABLED;
  try {
    process.env.RECALL_EMBEDDINGS_DISABLED = "true";
    const id = createMemory(db, {
      type: "rule", text: "Use uv for Python dependencies.",
      scope: "repo", repo: "fixture/outcomes", source: "user_correction", confidence: .99,
    });
    child = spawn(process.execPath, [
      resolve("node_modules/tsx/dist/cli.mjs"), resolve("src/daemon.ts"),
    ], {
      env: {
        ...process.env,
        HOME: dir,
        RECALL_DATA_DIR: dir,
        RECALL_PORT: String(port),
        RECALL_EMBEDDINGS_DISABLED: "true",
        RECALL_REPO_ROOTS: "/nonexistent-recall-feedback-roots",
        RECALL_MAINTENANCE_ENABLED: "false",
        RECALL_DISPATCHER_ENABLED: "false",
        RECALL_CLEANUP_ENABLED: "false",
        RECALL_QUALITY_SNAPSHOT_ENABLED: "false",
        RECALL_RELIABILITY_PROBE_ENABLED: "false",
        RECALL_RELIABILITY_VERDICT_ENABLED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    let ready = false;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && child.exitCode === null) {
      try { ready = (await fetch(`${url}/health`)).ok; } catch { /* Waiting for startup. */ }
      if (ready) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    expect(ready, output).toBe(true);
    const compiled = await fetch(`${url}/compile`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "fixture/outcomes", session_id: "session-http" }),
    });
    expect(compiled.status).toBe(200);
    expect(await compiled.text()).toContain(id);
    const feedback = await fetch(`${url}/feedback`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        memory_id: id, session_id: "session-http", injected: true, outcome: "followed",
      }),
    });
    expect(feedback.status).toBe(200);
    const result = await feedback.json() as { feedback_id: string };
    expect(result.feedback_id).toBeTruthy();
    expect(db.$client.prepare("SELECT outcome FROM memory_injections WHERE memory_id=?")
      .get(id)).toEqual({ outcome: "followed" });
    expect(db.$client.prepare("SELECT event_type, feedback_id FROM memory_value_events WHERE memory_id=? AND event_type='followed'")
      .get(id)).toEqual({ event_type: "followed", feedback_id: result.feedback_id });
  } finally {
    if (child) await stop(child);
    if (previousDisabled === undefined) delete process.env.RECALL_EMBEDDINGS_DISABLED;
    else process.env.RECALL_EMBEDDINGS_DISABLED = previousDisabled;
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
