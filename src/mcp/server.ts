import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRecallMcpServer } from "./factory.js";

async function main() {
  const server = createRecallMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
