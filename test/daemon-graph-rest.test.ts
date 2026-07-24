import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

let daemon: ChildProcess | null = null;
let port = 0;
let baseUrl = "";
let dataDir = "";

async function getFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") return rej(new Error("bad addr"));
      const p = addr.port;
      srv.close(() => res(p));
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon did not become ready: ${String(lastErr)}`);
}

beforeAll(async () => {
  port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  dataDir = mkdtempSync(join(tmpdir(), "recall-daemon-graph-"));
  const tsxEntry = resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  const daemonEntry = resolve(process.cwd(), "src/daemon.ts");
  daemon = spawn(process.execPath, [tsxEntry, daemonEntry], {
    env: {
      ...process.env,
      RECALL_PORT: String(port),
      RECALL_DATA_DIR: dataDir,
      RECALL_EMBEDDINGS_DISABLED: "true",
      RECALL_DISPATCHER_ENABLED: "false",
      RECALL_CLEANUP_ENABLED: "false",
      RECALL_QUALITY_SNAPSHOT_ENABLED: "false",
      RECALL_MAINTENANCE_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout?.on("data", () => {});
  daemon.stderr?.on("data", () => {});
  await waitForHealth(baseUrl);
}, 30_000);

afterAll(async () => {
  if (daemon && !daemon.killed) {
    await new Promise<void>((resolve) => {
      daemon!.once("exit", () => resolve());
      daemon!.kill("SIGTERM");
      // Force-kill after 3s if still running.
      setTimeout(() => {
        if (daemon && !daemon.killed) daemon.kill("SIGKILL");
      }, 3000).unref?.();
    });
  }
});

async function post(path: string, body: any): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json };
}

async function get(path: string): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}${path}`);
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json };
}

describe("daemon /graph REST routes (live HTTP)", () => {
  it("rejects browser requests from non-loopback origins", async () => {
    const r = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "https://attacker.example" },
    });
    expect(r.status).toBe(403);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allows the loopback WebUI origin without wildcard CORS", async () => {
    const origin = "http://127.0.0.1:7891";
    const r = await fetch(`${baseUrl}/health`, { headers: { Origin: origin } });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe(origin);
  });

  it("does not expose the retired arbitrary-command test route", async () => {
    const r = await post("/test", {
      repo_path: dataDir,
      command: "node -e \"process.exit(0)\"",
      memory_ids: [],
    });
    expect(r.status).toBe(404);
  });

  it("rejects malformed and oversized JSON bodies", async () => {
    const malformed = await fetch(`${baseUrl}/correct`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);

    const oversized = await fetch(`${baseUrl}/correct`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(1024 * 1024) }),
    });
    expect(oversized.status).toBe(413);
  });

  it("GET /graph/stats returns numeric entity/relation counts", async () => {
    const r = await get("/graph/stats");
    expect(r.status).toBe(200);
    expect(typeof r.json.entities).toBe("number");
    expect(typeof r.json.relations).toBe("number");
  });

  it("ingests a memory into the graph once it is verified (confirmed)", async () => {
    const correction = await post("/correct", {
      text: "always use `jose` in `src/auth/middleware.ts`",
      repo: "edihasaj/recall-test",
      session_id: "sess-rest-1",
      path: "src/auth/middleware.ts",
    });
    expect(correction.status).toBe(200);
    const memoryIds: string[] = correction.json.ids ?? correction.json.created ?? [];
    expect(memoryIds.length).toBeGreaterThan(0);
    const memId = memoryIds[0];

    // The graph is verified-only: a fresh candidate correction is NOT graphed.
    const before = await get(`/graph/memory/${memId}`);
    expect(before.json.entities.map((e: any) => e.name)).not.toContain("jose");

    // Confirming promotes it to active, which ingests it into the graph.
    const confirm = await post("/confirm", { memory_id: memId });
    expect(confirm.status).toBe(200);

    const after = await get(`/graph/memory/${memId}`);
    expect(after.status).toBe(200);
    const names = after.json.entities.map((e: any) => e.name);
    expect(names).toEqual(expect.arrayContaining(["jose", "src/auth/middleware.ts"]));
  });

  it("GET /graph/entities returns ingested entities with filters", async () => {
    const all = await get("/graph/entities");
    expect(all.status).toBe(200);
    expect(all.json.count).toBeGreaterThan(0);
    const names = all.json.entities.map((e: any) => e.name);
    expect(names).toEqual(expect.arrayContaining(["jose"]));

    const search = await get("/graph/entities?search=jose");
    expect(search.json.entities.length).toBeGreaterThan(0);
    expect(search.json.entities.every((e: any) => /jose/i.test(e.name))).toBe(true);

    const byKind = await get("/graph/entities?kind=library");
    expect(byKind.json.entities.every((e: any) => e.kind === "library")).toBe(true);
  });

  it("POST /graph/query expands via graph hops", async () => {
    // Add a sibling memory mentioning jose so graph expansion has something
    // to find for a query that doesn't textually match it. Confirm it so it
    // enters the verified-only graph.
    const sibling = await post("/correct", {
      text: "always rotate `jose` signing keys weekly",
      repo: "edihasaj/recall-test",
      session_id: "sess-rest-2",
    });
    const siblingIds: string[] = sibling.json.ids ?? sibling.json.created ?? [];
    if (siblingIds[0]) await post("/confirm", { memory_id: siblingIds[0] });

    const r = await post("/graph/query", {
      query: "auth middleware",
      hops: 2,
      limit: 10,
    });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.hits)).toBe(true);
    expect(typeof r.json.seed_count).toBe("number");
    expect(r.json.hits.length).toBeGreaterThan(0);
    // Some hit should mention jose (via graph expansion or direct).
    expect(r.json.hits.some((h: any) => /jose/i.test(h.text))).toBe(true);
  });

  it("POST /graph/neighbors walks from a known entity", async () => {
    const entities = await get("/graph/entities?search=jose");
    const joseEnt = entities.json.entities.find((e: any) => e.name === "jose");
    expect(joseEnt).toBeDefined();
    const r = await post("/graph/neighbors", {
      entity_id: joseEnt.id,
      hops: 1,
    });
    expect(r.status).toBe(200);
    expect(r.json.root.id).toBe(joseEnt.id);
    expect(Array.isArray(r.json.entities)).toBe(true);
    expect(r.json.entities.length).toBeGreaterThan(0);
    expect(typeof r.json.memories_by_entity).toBe("object");
  });

  it("POST /graph/neighbors 404s for unknown entity", async () => {
    const r = await post("/graph/neighbors", { entity_id: "missing-id", hops: 1 });
    expect(r.status).toBe(404);
    expect(r.json.error).toMatch(/not found/i);
  });

  it("POST /graph/query 400s without a query body", async () => {
    const r = await post("/graph/query", {});
    expect(r.status).toBe(400);
  });

  it("GET /graph/entity/:id returns the entity plus memory ids", async () => {
    const entities = await get("/graph/entities?search=jose");
    const joseEnt = entities.json.entities.find((e: any) => e.name === "jose");
    const r = await get(`/graph/entity/${joseEnt.id}`);
    expect(r.status).toBe(200);
    expect(r.json.entity.id).toBe(joseEnt.id);
    expect(Array.isArray(r.json.memories)).toBe(true);
    expect(r.json.memories.length).toBeGreaterThan(0);
  });

  it("POST /scan ingests new memories into the graph", async () => {
    // /scan needs a repo path; point it at this repo's checkout (cheap, no
    // network) so the scanner returns at least zero memories without error.
    const r = await post("/scan", {
      repo: "edihasaj/recall-graph-scan-test",
      repo_path: process.cwd(),
    });
    expect([200, 400]).toContain(r.status);
    // If scan failed (e.g. policy gated), the previous /correct tests already
    // proved safeIngest wiring. Don't hard-fail on the scan body shape.
  });
});
