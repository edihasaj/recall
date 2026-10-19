import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createMcpServer,
  generateKeyPair,
} from "@universalmemoryprotocol/core";
import { describe, expect, it } from "vitest";
import { initStandaloneDb } from "../src/db/client.js";
import { compileContextHybrid } from "../src/compiler/context.js";
import {
  createMemory,
  getMemory,
  promoteMemory,
  queryMemories,
  restoreAutoInject,
} from "../src/models/memory.js";
import { createRecallUmpServer } from "../src/ump/serve.js";
import { loadPersistedUmpOperatorKey } from "../src/ump/identity.js";

let dbCounter = 0;

async function connectedUmp() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const db = initStandaloneDb(join(
    mkdtempSync(join(tmpdir(), "recall-ump-temporal-")),
    `test-${dbCounter++}.db`,
  ));
  const key = generateKeyPair(new Uint8Array(32).fill(dbCounter));
  const { server, owner } = createRecallUmpServer(db, { key });
  const { mcp, client } = await connectMcp(server, owner);
  return { client, db, mcp, owner };
}

async function connectMcp(server: ReturnType<typeof createRecallUmpServer>["server"], owner: string) {
  const mcp = createMcpServer(server, { owner });
  const client = new Client({ name: "recall-ump-temporal-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  return { mcp, client };
}

function resultJson(result: unknown): any {
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text!);
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

function draft(
  owner: string,
  text: string,
  validFrom: string,
  options: {
    observed?: string;
    validTo?: string | null;
    project?: string;
    agent?: string;
    structured?: Record<string, unknown>;
  } = {},
) {
  return {
    kind: "semantic",
    body: { text, ...(options.structured ? { structured: options.structured } : {}) },
    scope: {
      owner,
      project: options.project ?? "owner/service",
      ...(options.agent ? { agent: options.agent } : {}),
      visibility: "private",
    },
    time: {
      created: validFrom,
      observed: options.observed ?? validFrom,
      valid_from: validFrom,
      valid_to: options.validTo ?? null,
    },
    lifecycle: { status: "active", confidence: 0.9 },
    provenance: {
      actor: owner,
      actor_kind: "user",
      method: "test",
      evidence: [{ ref: "test:temporal" }],
    },
  };
}

describe("Recall UMP temporal integration", () => {
  it("keeps its operator identity across restarts with owner-only seed permissions", () => {
    const directory = mkdtempSync(join(tmpdir(), "recall-ump-identity-"));
    const priorDataDirectory = process.env.RECALL_DATA_DIR;
    process.env.RECALL_DATA_DIR = directory;
    try {
      const first = loadPersistedUmpOperatorKey();
      const second = loadPersistedUmpOperatorKey();
      expect(second.did).toBe(first.did);
      expect(statSync(join(directory, "ump-operator-ed25519.seed")).mode & 0o777).toBe(0o600);
    } finally {
      if (priorDataDirectory === undefined) delete process.env.RECALL_DATA_DIR;
      else process.env.RECALL_DATA_DIR = priorDataDirectory;
    }
  });

  it("persists its owner and records across a real database restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "recall-ump-restart-"));
    const databasePath = join(directory, "recall.db");
    const firstDb = initStandaloneDb(databasePath);
    const first = createRecallUmpServer(firstDb);
    const firstConnection = await connectMcp(first.server, first.owner);
    const seedPath = join(directory, "ump-operator-ed25519.seed");
    let firstDbClosed = false;
    try {
      const stored = resultJson(await call(firstConnection.client, "ump.remember", draft(
        first.owner,
        "Production hosting is Azure.",
        "2026-01-01T00:00:00Z",
      )));
      const seedHash = createHash("sha256").update(readFileSync(seedPath)).digest("hex");
      await firstConnection.client.close();
      await firstConnection.mcp.close();
      firstDb.$client.close();
      firstDbClosed = true;

      const secondDb = initStandaloneDb(databasePath);
      const second = createRecallUmpServer(secondDb);
      const secondConnection = await connectMcp(second.server, second.owner);
      try {
        expect(second.owner).toBe(first.owner);
        expect(createHash("sha256").update(readFileSync(seedPath)).digest("hex")).toBe(seedHash);
        const historical = resultJson(await call(secondConnection.client, "ump.recall", {
          query: "production hosting",
          scope: { owner: second.owner, project: "owner/service" },
          filter: { valid_at: "2026-02-01T00:00:00Z" },
        }));
        expect(historical.results).toEqual([
          expect.objectContaining({
            record: expect.objectContaining({
              id: stored.id,
              body: expect.objectContaining({ text: "Production hosting is Azure." }),
            }),
          }),
        ]);
      } finally {
        await secondConnection.client.close();
        await secondConnection.mcp.close();
        secondDb.$client.close();
      }
    } finally {
      // The first connection/database are already closed before reopening. A
      // failed remember can reach this path before that cleanup, so close
      // defensively without changing the test fixture's files.
      await firstConnection.client.close().catch(() => {});
      await firstConnection.mcp.close().catch(() => {});
      if (!firstDbClosed) firstDb.$client.close();
    }
  });

  it("refuses a malformed persisted seed without replacing it", () => {
    const directory = mkdtempSync(join(tmpdir(), "recall-ump-invalid-seed-"));
    const databasePath = join(directory, "recall.db");
    const seedPath = join(directory, "ump-operator-ed25519.seed");
    writeFileSync(seedPath, Buffer.from([1, 2, 3]), { mode: 0o600 });
    const before = createHash("sha256").update(readFileSync(seedPath)).digest("hex");
    const db = initStandaloneDb(databasePath);
    try {
      expect(() => createRecallUmpServer(db)).toThrow("Invalid persisted Recall UMP operator identity");
      expect(createHash("sha256").update(readFileSync(seedPath)).digest("hex")).toBe(before);
    } finally {
      db.$client.close();
    }
  });

  it("fails closed when a persisted UMP record marker is malformed", async () => {
    const { client, db, mcp } = await connectedUmp();
    try {
      const id = createMemory(db, {
        type: "decision",
        text: "Malformed UMP source must not become an instruction.",
        scope: "repo",
        repo: "owner/service",
        source: "user_correction",
        confidence: 0.9,
        auto_inject: false,
        capture_context: { ump_record: null as never },
      });
      const context = await compileContextHybrid(db, {
        repo: "owner/service",
        query_text: "malformed UMP source",
        embedding_config: null,
        config: { confidence_threshold: 0 },
      });
      expect(context.memories_included).not.toContain(id);
      expect(promoteMemory(db, id, "explicit_confirm")).toBe(false);
      expect(restoreAutoInject(db, id)).toBe(false);
    } finally {
      await client.close();
      await mcp.close();
      db.$client.close();
    }
  });

  it("exposes temporal MCP filters and preserves structured records through a revision", async () => {
    const { client, db, mcp, owner } = await connectedUmp();
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "ump.remember", "ump.recall", "ump.revise", "ump.get",
      ]));

      const remembered = resultJson(await call(client, "ump.remember", draft(
        owner,
        "Production hosting is Azure.",
        "2026-01-01T00:00:00Z",
        {
          observed: "2026-01-02T00:00:00Z",
          structured: { provider: "Azure", source: "migration-log" },
        },
      )));
      expect(remembered.result).toBe("created");

      const stored = queryMemories(db, { repo: "owner/service" })[0]!;
      expect(stored.auto_inject).toBe(false);
      expect(stored.capture_context?.ump_record?.body.structured).toEqual({
        provider: "Azure",
        source: "migration-log",
      });
      expect(stored.capture_context?.ump_record?.id).toBe(remembered.id);
      expect(stored.capture_context?.ump_record?.integrity).toBeUndefined();
      const ordinaryContext = await compileContextHybrid(db, {
        repo: "owner/service",
        query_text: "What hosting should I use?",
        embedding_config: null,
        config: { confidence_threshold: 0 },
      });
      expect(ordinaryContext.memories_included).not.toContain(stored.id);
      expect(promoteMemory(db, stored.id, "explicit_confirm")).toBe(false);
      expect(restoreAutoInject(db, stored.id)).toBe(false);
      expect(getMemory(db, stored.id)?.auto_inject).toBe(false);

      const observed = resultJson(await call(client, "ump.get", {
        id: remembered.id,
        scope: { owner, project: "owner/service" },
      }));
      expect(observed.record.time.observed).toBe("2026-01-02T00:00:00Z");
      expect(observed.record.body.structured).toEqual({
        provider: "Azure",
        source: "migration-log",
      });

      const revision = resultJson(await call(client, "ump.revise", {
        id: remembered.id,
        patch: {
          body: { text: "Production hosting is Cloudflare." },
          time: { valid_from: "2026-03-01T00:00:00Z" },
        },
      }));
      expect(revision.id).not.toBe(remembered.id);

      const january = resultJson(await call(client, "ump.recall", {
        query: "production hosting",
        scope: { owner, project: "owner/service" },
        filter: { valid_at: "2026-02-15T00:00:00Z" },
        limit: 1,
      }));
      expect(january.results).toEqual([
        expect.objectContaining({
          record: expect.objectContaining({ body: expect.objectContaining({ text: "Production hosting is Azure." }) }),
        }),
      ]);

      const april = resultJson(await call(client, "ump.recall", {
        query: "production hosting",
        scope: { owner, project: "owner/service" },
        filter: { valid_at: "2026-04-01T00:00:00Z" },
        limit: 1,
      }));
      expect(april.results).toEqual([
        expect.objectContaining({
          record: expect.objectContaining({ body: expect.objectContaining({ text: "Production hosting is Cloudflare." }) }),
        }),
      ]);

      const predecessor = getMemory(db, stored.id)!;
      expect(predecessor.status).not.toBe("rejected");
      expect(predecessor.capture_context?.ump_record?.time.valid_to).toBe("2026-03-01T00:00:00Z");
      expect(predecessor.capture_context?.ump_record?.superseded_by).toContain(revision.id);
    } finally {
      await client.close();
      await mcp.close();
      db.$client.close();
    }
  });

  it("filters before capping, isolates scope, rejects invalid dates, and excludes future records by default", async () => {
    const { client, db, mcp, owner } = await connectedUmp();
    try {
      for (let index = 0; index < 20; index++) {
        resultJson(await call(client, "ump.remember", draft(
          owner,
          `Hosting decoy ${index} is Azure.`,
          "2026-01-01T00:00:00Z",
          { project: `other/project-${index}` },
        )));
      }
      resultJson(await call(client, "ump.remember", draft(
        owner,
        "Hosting eligible is Cloudflare.",
        "2026-01-01T00:00:00Z",
      )));
      resultJson(await call(client, "ump.remember", draft(
        owner,
        "Hosting future is Nextgen.",
        "2099-01-01T00:00:00Z",
      )));

      const eligible = resultJson(await call(client, "ump.recall", {
        query: "hosting",
        scope: { owner, project: "owner/service" },
        limit: 1,
      }));
      expect(eligible.results).toHaveLength(1);
      expect(eligible.results[0].record.body.text).toBe("Hosting eligible is Cloudflare.");

      const wrongOwner = resultJson(await call(client, "ump.recall", {
        query: "hosting",
        scope: { owner: "did:key:zWrong", project: "owner/service" },
        filter: { valid_at: "2026-02-01T00:00:00Z" },
      }));
      expect(wrongOwner.results).toEqual([]);

      const invalid = await call(client, "ump.recall", {
        query: "hosting",
        scope: { owner, project: "owner/service" },
        filter: { valid_at: "not-a-date" },
      });
      expect((invalid as { isError?: boolean }).isError).toBe(true);
      expect(resultJson(invalid).error.message).toMatch(/RFC 3339/i);
    } finally {
      await client.close();
      await mcp.close();
      db.$client.close();
    }
  });

  it("keeps duplicate text with separate validity windows and hides soft or hard forgets historically", async () => {
    const { client, db, mcp, owner } = await connectedUmp();
    try {
      const first = resultJson(await call(client, "ump.remember", draft(
        owner, "The deployment channel is stable.", "2026-01-01T00:00:00Z",
        { validTo: "2026-02-01T00:00:00Z" },
      )));
      const second = resultJson(await call(client, "ump.remember", draft(
        owner, "The deployment channel is stable.", "2026-03-01T00:00:00Z",
      )));
      expect(second.id).not.toBe(first.id);

      await call(client, "ump.forget", { id: first.id, reason: "removed", hard: false });
      await call(client, "ump.forget", { id: second.id, reason: "erased", hard: true });

      for (const at of ["2026-01-15T00:00:00Z", "2026-04-01T00:00:00Z"]) {
        const recalled = resultJson(await call(client, "ump.recall", {
          query: "deployment channel",
          scope: { owner, project: "owner/service" },
          filter: { valid_at: at },
        }));
        expect(recalled.results).toEqual([]);
      }
    } finally {
      await client.close();
      await mcp.close();
      db.$client.close();
    }
  });
});
