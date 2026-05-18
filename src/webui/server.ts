/**
 * Toggleable HTTP+WS listener for the WebUI. Mounted on demand by the
 * daemon when the user clicks "Open Dashboard" in the menubar or runs
 * `recall ui start`. Serves the static SPA built into `dist/webui/` and
 * upgrades `/ws` to a localhost-only WebSocket bridged to the daemon's
 * event bus.
 *
 * All mutations go through the daemon REST API on :7890. This listener
 * is read-mostly: it only forwards bus events and serves bytes.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";
import { handleUpgrade, isLocalRequest, shutdown as shutdownWs, clientCount } from "./ws.js";

export interface WebUIServerOptions {
  port?: number;
  host?: string;
  /** Override the dist directory; defaults to <package>/dist/webui. */
  distDir?: string;
}

export interface WebUIServerStatus {
  running: boolean;
  port: number | null;
  host: string | null;
  url: string | null;
  client_count: number;
  dist_dir: string | null;
  dist_exists: boolean;
  started_at: string | null;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json",
};

let active: { server: Server; port: number; host: string; distDir: string; startedAt: string } | null = null;

function defaultDistDir(): string {
  // src/webui/server.ts -> dist/webui at runtime (after tsup, the compiled
  // file lives at dist/webui/server.js — but we resolve from package root
  // so it works in both dev (tsx) and prod (bundled) layouts).
  const here = fileURLToPath(new URL(".", import.meta.url));
  // Walk up to find a directory containing package.json.
  let dir = here;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) {
      return join(dir, "dist", "webui");
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return join(here, "..", "..", "dist", "webui");
}

export function getStatus(): WebUIServerStatus {
  if (!active) {
    const distDir = defaultDistDir();
    return {
      running: false,
      port: null,
      host: null,
      url: null,
      client_count: 0,
      dist_dir: distDir,
      dist_exists: existsSync(distDir),
      started_at: null,
    };
  }
  return {
    running: true,
    port: active.port,
    host: active.host,
    url: `http://${active.host}:${active.port}`,
    client_count: clientCount(),
    dist_dir: active.distDir,
    dist_exists: existsSync(active.distDir),
    started_at: active.startedAt,
  };
}

export async function start(options: WebUIServerOptions = {}): Promise<WebUIServerStatus> {
  if (active) return getStatus();
  const port = options.port ?? parseInt(process.env.RECALL_WEBUI_PORT ?? "7891", 10);
  const host = options.host ?? "127.0.0.1";
  const distDir = options.distDir ?? defaultDistDir();

  const server = createServer((req, res) => handleHttp(req, res, distDir));
  server.on("upgrade", (req, socket) => {
    if (req.url === "/ws") {
      handleUpgrade(req, socket as Socket);
    } else {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  active = { server, port, host, distDir, startedAt: new Date().toISOString() };
  return getStatus();
}

export async function stop(): Promise<WebUIServerStatus> {
  if (!active) return getStatus();
  const a = active;
  active = null;
  shutdownWs();
  await new Promise<void>((resolve) => {
    a.server.close(() => resolve());
  });
  return getStatus();
}

export function isRunning(): boolean {
  return active !== null;
}

function handleHttp(req: IncomingMessage, res: ServerResponse, distDir: string): void {
  // CORS for fetches from the SPA itself + same-origin (browser ignores anyway)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-cache");

  if (req.method === "GET" && req.url === "/__webui/status") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(getStatus()));
    return;
  }

  // Reject non-local requests for static files too — the WebUI is single-user.
  if (!isLocalRequest(req)) {
    res.statusCode = 403;
    res.end();
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.end();
    return;
  }

  const rawPath = (req.url ?? "/").split("?")[0];
  const decoded = safeDecode(rawPath);
  if (decoded === null) {
    res.statusCode = 400;
    res.end();
    return;
  }

  // SPA: route everything that isn't a file to index.html.
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const fullPath = normalize(join(distDir, relative));
  if (!fullPath.startsWith(distDir + sep) && fullPath !== distDir) {
    res.statusCode = 403;
    res.end();
    return;
  }

  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    // Fallback to index.html for client-side routing — but only if dist exists.
    const indexPath = join(distDir, "index.html");
    if (existsSync(indexPath)) {
      serveFile(res, indexPath);
    } else {
      res.statusCode = 503;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(missingBundleHtml(distDir));
    }
    return;
  }

  serveFile(res, fullPath);
}

function safeDecode(p: string): string | null {
  try {
    return decodeURIComponent(p);
  } catch {
    return null;
  }
}

function serveFile(res: ServerResponse, file: string): void {
  const mime = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  res.statusCode = 200;
  res.setHeader("Content-Type", mime);
  createReadStream(file).pipe(res);
}

function missingBundleHtml(distDir: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Recall WebUI — bundle missing</title>
<style>body{font-family:system-ui;max-width:560px;margin:80px auto;color:#222;padding:0 16px}code{background:#f4f4f4;padding:2px 4px;border-radius:3px}</style>
</head><body>
<h1>WebUI bundle not built</h1>
<p>The Recall daemon is running and the WebUI port is open, but the static SPA bundle was not found at:</p>
<pre><code>${escapeHtml(distDir)}</code></pre>
<p>Run <code>npm run webui:build</code> (or the wrapping <code>npm run build</code>) and reload this page.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
