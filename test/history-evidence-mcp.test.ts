import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initStandaloneDb } from "../src/db/client.js";
import { historyInjections, historySnippets } from "../src/db/schema.js";
import { createHistorySnippet } from "../src/history/snippets.js";
import { syncHistoryFtsIndex } from "../src/vector/sqlite-fts-history.js";
import { createRecallMcpServer } from "../src/mcp/factory.js";

afterEach(() => vi.unstubAllEnvs());

it("delivers the relevant dated history through the real MCP query handler", async () => {
  vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "true");
  vi.stubEnv("RECALL_REPO_ROOTS", "/nonexistent-recall-evidence-test");
  const db = initStandaloneDb(join(mkdtempSync(join(tmpdir(), "recall-history-mcp-")), "test.db"));
  const server = createRecallMcpServer(db);
  const client = new Client({ name: "history-evidence-test", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    const id = createHistorySnippet(db, {
      repo: "fixtures/mcp-evidence", kind: "decision_summary",
      text: [
        "Prior decisions:",
        ...Array.from({ length: 12 }, (_, index) => `- Archived display option ${index}.`),
        "- Sora workers now run by the harbor; the hill location is obsolete.",
      ].join("\n"),
    });
    db.update(historySnippets).set({ updated_at: "2026-10-01T12:00:00Z" })
      .where(eq(historySnippets.id, id)).run();
    syncHistoryFtsIndex(db, id);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({
      name: "query", arguments: {
        repo: "fixtures/mcp-evidence", query_text: "Sora workers location",
        session_id: "history-evidence-session",
      },
    });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.map((block) => block.text ?? "").join("\n");
    expect(text).toContain("Sora workers now run by the harbor");
    expect(text).toContain("hill location is obsolete");
    expect(text).toContain("2026-10-01");
    expect(db.select().from(historyInjections).all()).toEqual([
      expect.objectContaining({ snippet_id: id, session_id: "history-evidence-session" }),
    ]);
  } finally {
    await client.close();
    await server.close();
    db.$client.close();
  }
});
