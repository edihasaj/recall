import type { IncomingMessage, ServerResponse } from "node:http";
import { JsonBodyError, parseJsonBody } from "../daemon/body.js";
import { CloudError } from "./errors.js";
import type { CloudService } from "./service.js";

const MAX_CLOUD_BODY_BYTES = 16 * 1024;

function send(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

/**
 * Loopback-only control routes for the Recall app. The token only ever arrives
 * in a POST body and is never echoed, logged or returned in status.
 * Returns false for paths this module does not own.
 */
export async function handleCloudRoute(
  service: CloudService,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
): Promise<boolean> {
  if (!path.startsWith("/cloud/")) return false;
  try {
    if (path === "/cloud/status" && method === "GET") {
      send(res, 200, service.status());
      return true;
    }
    if (method !== "POST" || !["/cloud/connect", "/cloud/disconnect", "/cloud/migrate", "/cloud/query"].includes(path)) {
      return false;
    }
    const body = await parseJsonBody(req, MAX_CLOUD_BODY_BYTES);
    const input = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    if (path === "/cloud/connect") send(res, 200, await service.connect(input));
    else if (path === "/cloud/migrate") send(res, 200, await service.migrateLegacy(input));
    else if (path === "/cloud/query") send(res, 200, await service.setQueryEnrichment((input as { enabled?: unknown }).enabled));
    else send(res, 200, await service.disconnect());
    return true;
  } catch (error) {
    if (error instanceof JsonBodyError) throw error;
    if (error instanceof CloudError) {
      send(res, error.status, { error: error.message, code: error.code });
      return true;
    }
    send(res, 500, { error: "Cloud sync request failed", code: "internal" });
    return true;
  }
}
