import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { initStandaloneDb, type RecallDb } from "../src/db/client.js";
import { handleRecallMcpHttpRequest } from "../src/mcp/http.js";
import { createMemory } from "../src/models/memory.js";
import { syncMemoryFtsIndex } from "../src/vector/sqlite-fts.js";
import { ingestMemoryHeuristic } from "../src/graph/ingest.js";
import { listEntities } from "../src/graph/store.js";
import { installMockEmbeddingProvider } from "./helpers/mock-embedding-provider.js";

installMockEmbeddingProvider();

let openServer: Server | null = null;
let client: Client | null = null;

afterEach(async () => {
  if (client) {
    await client.close().catch(() => {});
    client = null;
  }
  if (openServer) {
    await new Promise<void>((resolve, reject) => {
      openServer!.close((error) => (error ? reject(error) : resolve()));
    });
    openServer = null;
  }
});

function listen(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function startMcpForDb(db: RecallDb) {
  openServer = createServer((req, res) => {
    if (req.url === "/mcp") {
      void handleRecallMcpHttpRequest(req, res, db);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await listen(openServer);
  const address = openServer.address();
  if (!address || typeof address === "string") throw new Error("expected TCP server address");
  client = new Client({ name: "recall-graph-test", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );
  await client.connect(transport);
  return client;
}

function seed(db: RecallDb, text: string, repo = "demo"): string {
  const id = createMemory(db, {
    type: "rule",
    text,
    scope: "repo",
    repo,
    source: "manual",
    confidence: 0.8,
  });
  ingestMemoryHeuristic(db, { id, text, repo });
  return id;
}

function parseToolJson(result: any): any {
  const text = result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text as string);
}

let dbCounter = 0;
function freshDb(): RecallDb {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-mcp-graph-"));
  return initStandaloneDb(join(dir, `graph-${dbCounter++}.db`));
}

describe("MCP graph tools", () => {
  let db: RecallDb;

  beforeEach(() => {
    db = freshDb();
  });

  it("registers graph_query, graph_neighbors, and entity_list", async () => {
    const c = await startMcpForDb(db);
    const tools = await c.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["graph_query", "graph_neighbors", "entity_list"]));
  });

  it("entity_list returns ingested entities and respects search/kind filters", async () => {
    seed(db, "Use `react` and `react-dom` plus `npm` install.");
    syncMemoryFtsIndex(db);
    const c = await startMcpForDb(db);

    const all = parseToolJson(await c.callTool({ name: "entity_list", arguments: {} }));
    expect(all.count).toBeGreaterThan(0);
    const names = all.entities.map((e: any) => e.name);
    expect(names).toEqual(expect.arrayContaining(["react", "react-dom", "npm"]));

    const onlyLibs = parseToolJson(
      await c.callTool({ name: "entity_list", arguments: { kind: "library" } }),
    );
    expect(onlyLibs.entities.every((e: any) => e.kind === "library")).toBe(true);

    const searchReact = parseToolJson(
      await c.callTool({ name: "entity_list", arguments: { search: "react" } }),
    );
    expect(searchReact.entities.length).toBeGreaterThanOrEqual(2);
    expect(
      searchReact.entities.every((e: any) => /react/i.test(e.name)),
    ).toBe(true);
  });

  it("graph_query expands via shared entities (1 hop)", async () => {
    seed(db, "Use `jose` in `src/auth/middleware.ts` for token verification.");
    const idB = seed(db, "Rotate signing keys for `jose` weekly.");
    syncMemoryFtsIndex(db);
    const c = await startMcpForDb(db);

    const payload = parseToolJson(
      await c.callTool({
        name: "graph_query",
        arguments: { query: "auth", hops: 1, limit: 10 },
      }),
    );
    const ids = payload.hits.map((h: any) => h.memory_id);
    expect(ids).toContain(idB);
    const bHit = payload.hits.find((h: any) => h.memory_id === idB);
    expect(bHit.via).toBe("graph");
    expect(bHit.shared_entities.length).toBeGreaterThan(0);
  });

  it("graph_query with hops=0 returns only seed hits", async () => {
    seed(db, "Use `jose` in `src/auth/middleware.ts`.");
    const idB = seed(db, "Rotate keys for `jose` weekly.");
    syncMemoryFtsIndex(db);
    const c = await startMcpForDb(db);

    const payload = parseToolJson(
      await c.callTool({
        name: "graph_query",
        arguments: { query: "auth", hops: 0, limit: 10 },
      }),
    );
    expect(payload.hits.find((h: any) => h.memory_id === idB)).toBeUndefined();
  });

  it("graph_neighbors walks one hop and includes memory ids", async () => {
    seed(db, "We replaced `jsonwebtoken` with `jose`.");
    syncMemoryFtsIndex(db);
    const ents = listEntities(db, { search: "jose" });
    const joseEnt = ents.find((e) => e.name === "jose");
    expect(joseEnt).toBeDefined();
    const c = await startMcpForDb(db);

    const payload = parseToolJson(
      await c.callTool({
        name: "graph_neighbors",
        arguments: { entity_id: joseEnt!.id, hops: 1 },
      }),
    );
    expect(payload.root.id).toBe(joseEnt!.id);
    const names = payload.entities.map((e: any) => e.name);
    expect(names).toEqual(expect.arrayContaining(["jose", "jsonwebtoken"]));
    expect(payload.relations.length).toBeGreaterThan(0);
    expect(Object.keys(payload.memories_by_entity).length).toBe(payload.entities.length);
  });

  it("graph_neighbors returns isError for an unknown entity_id", async () => {
    const c = await startMcpForDb(db);
    const raw = await c.callTool({
      name: "graph_neighbors",
      arguments: { entity_id: "does-not-exist", hops: 1 },
    });
    expect((raw as any).isError).toBe(true);
    const body = parseToolJson(raw);
    expect(body.error).toBe("entity not found");
  });

  it("graph_neighbors respects relation_types filter", async () => {
    // Two distinct relation types from the same source: `uses` and `replaces`.
    seed(db, "We replaced `jsonwebtoken` with `jose`.");
    seed(db, "The handler in `src/auth/middleware.ts` uses `jose` for token verification.");
    syncMemoryFtsIndex(db);
    const joseEnt = listEntities(db, { search: "jose" }).find((e) => e.name === "jose")!;
    const c = await startMcpForDb(db);

    const usesOnly = parseToolJson(
      await c.callTool({
        name: "graph_neighbors",
        arguments: { entity_id: joseEnt.id, hops: 1, relation_types: ["uses"] },
      }),
    );
    const names = usesOnly.entities.map((e: any) => e.name);
    expect(names).not.toContain("jsonwebtoken");
  });
});
