import type { IncomingMessage, ServerResponse } from "node:http";

const LOOPBACK_ADDRESSES = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
  "localhost",
]);

const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "[::1]",
  "::1",
  "localhost",
]);

export function isLoopbackAddress(address: string | undefined): boolean {
  return LOOPBACK_ADDRESSES.has(address ?? "");
}

export function isAllowedBrowserOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * The daemon is a privileged, single-user API. Non-browser local clients do
 * not send Origin; browser clients must come from the loopback WebUI.
 */
export function authorizeLocalRequest(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    deny(res);
    return false;
  }

  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (typeof origin !== "string" || !isAllowedBrowserOrigin(origin)) {
      deny(res);
      return false;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID",
    );
  }

  return true;
}

function deny(res: ServerResponse): void {
  res.statusCode = 403;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: "local request required" }));
}
