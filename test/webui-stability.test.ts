import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { createReadStream, mkdtempSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { start, stop, getStatus } from "../src/webui/server.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, createReadStream: vi.fn(fs.createReadStream), statSync: vi.fn(fs.statSync) };
});

const directories: string[] = [];
function bundle(): string {
  const dir = mkdtempSync(join(tmpdir(), "recall-webui-stability-"));
  directories.push(dir);
  writeFileSync(join(dir, "index.html"), "working dashboard");
  return dir;
}
async function pickPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}
afterEach(async () => {
  await stop();
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("dashboard failure isolation", () => {
  it("survives an invalid index file and serves a repaired bundle", async () => {
    const dir = bundle();
    renameSync(join(dir, "index.html"), join(dir, "saved-index.html"));
    mkdirSync(join(dir, "index.html"));
    const port = await pickPort();
    await start({ port, distDir: dir });
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(503);
    await response.text();
    renameSync(join(dir, "index.html"), join(dir, "invalid-index"));
    renameSync(join(dir, "saved-index.html"), join(dir, "index.html"));
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("working dashboard");
  });

  it("contains an asynchronous read failure instead of emitting an uncaught error", async () => {
    const port = await pickPort();
    await start({ port, distDir: bundle() });
    vi.mocked(createReadStream).mockImplementationOnce(() => {
      const stream = new PassThrough();
      queueMicrotask(() => stream.destroy(new Error("simulated file replacement during update")));
      return stream as ReturnType<typeof createReadStream>;
    });
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Dashboard asset unavailable");
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("working dashboard");
  });

  it("survives a file disappearing during the stat check", async () => {
    const port = await pickPort();
    await start({ port, distDir: bundle() });
    vi.mocked(statSync).mockImplementationOnce(() => { throw new Error("ENOENT"); });
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("working dashboard");
  });

  it("contains a read failure after response headers have been sent", async () => {
    const port = await pickPort();
    await start({ port, distDir: bundle() });
    const stream = new PassThrough();
    vi.mocked(createReadStream).mockReturnValueOnce(stream as ReturnType<typeof createReadStream>);
    const request = fetch(`http://127.0.0.1:${port}/`);
    const timer = setInterval(() => stream.write("partial"), 10);
    try {
      const response = await request;
      const body = response.text();
      stream.destroy(new Error("disk read failed after headers"));
      await expect(body).rejects.toThrow();
      expect((await fetch(`http://127.0.0.1:${port}/__webui/status`)).status).toBe(200);
    } finally { clearInterval(timer); stream.destroy(); }
  });

  it("closes the file stream when the browser disconnects", async () => {
    const port = await pickPort();
    await start({ port, distDir: bundle() });
    const stream = new PassThrough();
    vi.mocked(createReadStream).mockReturnValueOnce(stream as ReturnType<typeof createReadStream>);
    const controller = new AbortController();
    const closed = new Promise<void>((resolve) => stream.once("close", resolve));
    const request = fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
    const timer = setInterval(() => stream.write("chunk"), 10);
    try {
      const response = await request;
      controller.abort();
      await response.body?.cancel().catch(() => undefined);
      await closed;
      expect(stream.destroyed).toBe(true);
      expect((await fetch(`http://127.0.0.1:${port}/__webui/status`)).status).toBe(200);
    } finally { clearInterval(timer); stream.destroy(); }
  });

  it("does not open a file stream for HEAD requests", async () => {
    const port = await pickPort();
    await start({ port, distDir: bundle() });
    const response = await fetch(`http://127.0.0.1:${port}/`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(createReadStream).not.toHaveBeenCalled();
  });
});

describe("dashboard lifecycle races", () => {
  it("coalesces overlapping starts and preserves ordered stop/start operations", async () => {
    const port = await pickPort();
    const distDir = bundle();
    const starts = await Promise.all(Array.from({ length: 12 }, () => start({ port, distDir })));
    expect(starts.every((result) => result.running && result.port === port)).toBe(true);
    const outcomes = await Promise.all([stop(), start({ port, distDir }), stop()]);
    expect(outcomes.map((result) => result.running)).toEqual([false, true, false]);
    expect(getStatus().running).toBe(false);
    await start({ port, distDir });
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
  });

  it("recovers after a port conflict without poisoning later starts", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const port = (occupied.address() as { port: number }).port;
    try { await expect(start({ port, distDir: bundle() })).rejects.toMatchObject({ code: "EADDRINUSE" }); }
    finally { await new Promise<void>((resolve) => occupied.close(() => resolve())); }
    const status = await start({ port, distDir: bundle() });
    expect(status.running).toBe(true);
    expect((await fetch(`http://127.0.0.1:${port}/__webui/status`)).status).toBe(200);
  });
});
