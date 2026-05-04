import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { initStandaloneDb } from "../src/db/client.js";
import { handleRecallMcpHttpRequest } from "../src/mcp/http.js";

let openServer: Server | null = null;

afterEach(async () => {
  if (!openServer) return;
  await new Promise<void>((resolve, reject) => {
    openServer!.close((error) => error ? reject(error) : resolve());
  });
  openServer = null;
});

describe("Recall MCP over HTTP", () => {
  it("serves MCP tools over the daemon HTTP transport", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "recall-mcp-http-"));
    const db = initStandaloneDb(join(tempDir, "recall.db"));
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

    const client = new Client({ name: "recall-http-test", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(client.getServerVersion()).toEqual({ name: "recall", version: "0.5.0" });
      expect(tools.tools.some((tool) => tool.name === "query")).toBe(true);
      expect(tools.tools.some((tool) => tool.name === "capture_correction")).toBe(true);
    } finally {
      await client.close();
    }
  });
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
