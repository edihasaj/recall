import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { initStandaloneDb } from "../src/db/client.js";
import { createRecallMcpServer } from "../src/mcp/factory.js";

async function connectedMcp() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const db = initStandaloneDb(join(mkdtempSync(join(tmpdir(), "recall-temporal-mcp-")), "recall.db"));
  const server = createRecallMcpServer(db);
  const client = new Client({ name: "temporal-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { db, server, client };
}

function payload(result: unknown) {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text);
}

describe("temporal MCP tools", () => {
  it("records source evidence and queries present/past snapshots through the SDK", async () => {
    const { db, server, client } = await connectedMcp();
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["temporal_remember", "temporal_query"]));
      const stored = payload(await client.callTool({ name: "temporal_remember", arguments: {
        repo: "owner/service", event_id: "azure", subject: "production", predicate: "hosting",
        value: "Azure", valid_from: "2026-01-01", observed_at: "2026-01-02", evidence: "Source: Azure was used.",
      } }));
      await client.callTool({ name: "temporal_remember", arguments: {
        repo: "owner/service", event_id: "cloudflare", subject: "production", predicate: "hosting",
        value: "Cloudflare", valid_from: "2026-03-01", observed_at: "2026-03-02", evidence: "Source: migration complete.", supersedes_id: stored.id,
      } });
      const present = payload(await client.callTool({ name: "temporal_query", arguments: {
        repo: "owner/service", subject: "production", predicate: "hosting", as_of: "2026-04-01", observed_before: "2026-04-01",
      } }));
      const past = payload(await client.callTool({ name: "temporal_query", arguments: {
        repo: "owner/service", subject: "production", predicate: "hosting", as_of: "2026-02-01", observed_before: "2026-04-01",
      } }));
      expect(present.facts).toEqual([expect.objectContaining({ value: "Cloudflare", evidence: "Source: migration complete." })]);
      expect(past.facts).toEqual([expect.objectContaining({ value: "Azure" })]);
    } finally {
      await client.close(); await server.close(); db.$client.close();
    }
  });

  it("returns tool errors for invalid data and isolates repositories", async () => {
    const { db, server, client } = await connectedMcp();
    try {
      await client.callTool({ name: "temporal_remember", arguments: {
        repo: "owner/private", event_id: "secret", subject: "production", predicate: "hosting",
        value: "Private", valid_from: "2026-01-01", observed_at: "2026-01-02", evidence: "private source",
      } });
      const isolated = payload(await client.callTool({ name: "temporal_query", arguments: {
        repo: "owner/service", subject: "production", predicate: "hosting", as_of: "2026-02-01", observed_before: "2026-02-01",
      } }));
      expect(isolated.facts).toEqual([]);
      const invalid = await client.callTool({ name: "temporal_remember", arguments: {
        repo: "owner/service", event_id: "bad", subject: "production", predicate: "hosting",
        value: "x", valid_from: "2026-02-30", observed_at: "2026-01-02", evidence: "bad date",
      } });
      expect((invalid as { isError?: boolean }).isError).toBe(true);
      expect(payload(invalid).error).toMatch(/calendar/);
    } finally {
      await client.close(); await server.close(); db.$client.close();
    }
  });

  it("advertises typed inputs and rejects invalid input through the SDK", async () => {
    const { db, server, client } = await connectedMcp();
    try {
      const tools = (await client.listTools()).tools;
      const query = tools.find((tool) => tool.name === "temporal_query")!;
      expect(query.inputSchema.properties?.repo).toMatchObject({ type: "string" });
      expect(query.inputSchema.required).toContain("repo");
      const invalid = await client.callTool({ name: "temporal_query", arguments: {
        repo: 42, subject: "production", predicate: "hosting",
      } });
      expect(invalid.isError).toBe(true);
      expect(invalid.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("repo") }),
      ]));
    } finally {
      await client.close(); await server.close(); db.$client.close();
    }
  });
});
