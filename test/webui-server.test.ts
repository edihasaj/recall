import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStatus, isRunning, start, stop } from "../src/webui/server.js";

async function pickPort(): Promise<number> {
  // Pick an ephemeral port via a throwaway listener — keeps tests parallel-safe.
  const { createServer } = await import("node:http");
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

describe("webui server", () => {
  afterEach(async () => {
    if (isRunning()) await stop();
  });

  it("reports stopped before start", () => {
    const s = getStatus();
    expect(s.running).toBe(false);
    expect(s.port).toBeNull();
  });

  it("starts on a port and serves __webui/status", async () => {
    const port = await pickPort();
    const status = await start({ port });
    expect(status.running).toBe(true);
    expect(status.port).toBe(port);

    const res = await fetch(`http://127.0.0.1:${port}/__webui/status`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { running: boolean; port: number };
    expect(json.running).toBe(true);
    expect(json.port).toBe(port);
  });

  it("renders missing-bundle fallback when dist is absent", async () => {
    const port = await pickPort();
    const tmp = mkdtempSync(join(tmpdir(), "recall-webui-"));
    try {
      await start({ port, distDir: join(tmp, "does-not-exist") });
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(503);
      const body = await res.text();
      expect(body).toContain("WebUI bundle not built");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("serves index.html when bundle exists", async () => {
    const port = await pickPort();
    const tmp = mkdtempSync(join(tmpdir(), "recall-webui-"));
    const distDir = join(tmp, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "index.html"), "<!doctype html><body>hi</body>");
    try {
      await start({ port, distDir });
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("hi");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to index.html for unknown paths (SPA routing)", async () => {
    const port = await pickPort();
    const tmp = mkdtempSync(join(tmpdir(), "recall-webui-"));
    const distDir = join(tmp, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "index.html"), "<!doctype html><body>spa</body>");
    try {
      await start({ port, distDir });
      const res = await fetch(`http://127.0.0.1:${port}/memories/abc-123`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("spa");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects path traversal", async () => {
    const port = await pickPort();
    const tmp = mkdtempSync(join(tmpdir(), "recall-webui-"));
    const distDir = join(tmp, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "index.html"), "ok");
    writeFileSync(join(tmp, "secret.txt"), "nope");
    try {
      await start({ port, distDir });
      const res = await fetch(`http://127.0.0.1:${port}/../secret.txt`);
      // Either 403 from path check, or 200 with index.html fallback —
      // never the actual secret bytes.
      const body = await res.text();
      expect(body).not.toContain("nope");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("stop() releases the port", async () => {
    const port = await pickPort();
    await start({ port });
    await stop();
    // Should be able to bind same port immediately.
    const second = await start({ port });
    expect(second.running).toBe(true);
  });
});
