import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { RecallDb } from "../db/client.js";
import { createRecallMcpServer } from "./factory.js";

export async function handleRecallMcpHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  db: RecallDb,
) {
  if (req.method !== "POST") {
    return sendJsonRpcError(res, 405, -32000, "Method not allowed");
  }

  const mcpServer = createRecallMcpServer(db);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    if (!res.headersSent) {
      sendJsonRpcError(
        res,
        500,
        -32603,
        error instanceof Error ? error.message : "Internal server error",
      );
    }
  } finally {
    await transport.close().catch(() => {});
    await mcpServer.close().catch(() => {});
  }
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  }));
}
