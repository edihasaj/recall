// Run alongside RecallStoreTests/testExternalMCPClient in the signed test host.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const origin = "http://127.0.0.1:37902";
let ready = false;
for (let attempt = 0; attempt < 240; attempt += 1) {
  try {
    const health = await fetch(`${origin}/health`).then(response => response.json());
    if (health.status === "ok") { ready = true; break; }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 250));
}
if (!ready) throw new Error("The signed test fixture service is not ready");

const client = new Client({ name: "recall-store-external-proof", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
try {
  const tools = await client.listTools();
  if (!tools.tools.some(tool => tool.name === "query")) throw new Error("Query tool unavailable");
  let found = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await client.callTool({ name: "query", arguments: { repo: "store-proof/fixture" } });
    if (JSON.stringify(result).includes("uv")) { found = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!found) throw new Error("Stored fixture rule missing from MCP query");
  const response = await fetch(`${origin}/store/memory`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "External MCP client verified." }),
  });
  if (!response.ok) throw new Error("Fixture completion marker failed");
  console.log(JSON.stringify({ externalMcp: true, queryTool: true, storedMemoryRetrieved: true }));
} finally {
  await client.close();
}
