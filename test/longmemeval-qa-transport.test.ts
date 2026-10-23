import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { longRequestFetch } from "../benchmark/longmemeval-qa-transport.js";

async function withServer(run: (base: string) => Promise<void>) {
  const server = createServer((request, response) => {
    if (request.url === "/delayed") return void setTimeout(() => response.end("ready"), 40);
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/delayed" });
      return void response.end();
    }
    if (request.url === "/large") {
      response.write("x");
      return void response.end("x".repeat(4 * 1024 * 1024));
    }
    if (request.url === "/large-length") {
      response.writeHead(200, { "content-length": 4 * 1024 * 1024 + 1 });
      return void response.end();
    }
    if (request.url === "/no-content") {
      response.writeHead(204);
      return void response.end();
    }
    if (request.url === "/reset") {
      response.writeHead(205);
      return void response.end();
    }
    if (request.url === "/not-modified") {
      response.writeHead(304);
      return void response.end();
    }
    if (request.url === "/invalid-status") {
      response.writeHead(600);
      return void response.end("private proxy response body");
    }
    if (request.url === "/stream") {
      response.write("first");
      return void setTimeout(() => response.end("second"), 80);
    }
    if (request.url === "/echo") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      return void request.on("end", () => response.end(`${request.headers["x-test"]}:${body}`));
    }
    response.end("ok");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
}

describe("LongMemEval native long-request transport", () => {
  it("waits for delayed headers until the supplied caller deadline", async () => {
    await withServer(async (base) => {
      const response = await longRequestFetch(`${base}/delayed`, { signal: AbortSignal.timeout(500) });
      expect(await response.text()).toBe("ready");
    });
  });
  it("does not follow redirects", async () => {
    await withServer(async (base) => {
      const response = await longRequestFetch(`${base}/redirect`);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/delayed");
    });
  });
  it("accepts body-forbidden status responses without constructing an invalid Response", async () => {
    await withServer(async (base) => {
      for (const [path, status] of [["no-content", 204], ["reset", 205], ["not-modified", 304]] as const) {
        const response = await longRequestFetch(`${base}/${path}`);
        expect(response.status).toBe(status);
        expect(await response.text()).toBe("");
      }
    });
  });
  it("rejects invalid upstream statuses without leaving a request pending or leaking response text", async () => {
    await withServer(async (base) => {
      const unhandled: unknown[] = [];
      const listener = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", listener);
      try {
        const outcome = await Promise.race([
          longRequestFetch(`${base}/invalid-status`, { signal: AbortSignal.timeout(80) })
            .then(() => new Error("Expected invalid status rejection"), (error: unknown) => error),
          new Promise<Error>((resolve) => setTimeout(() => resolve(new Error("request still pending")), 160)),
        ]);
        expect(String(outcome)).toContain("Response construction failed");
        expect(String(outcome)).not.toContain("private proxy response body");
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
      } finally {
        process.removeListener("unhandledRejection", listener);
      }
    });
  });
  it("accepts string POST bodies and string headers", async () => {
    await withServer(async (base) => {
      const response = await longRequestFetch(`${base}/echo`, {
        method: "POST", headers: { "x-test": "header-value" }, body: "request-value",
      });
      expect(await response.text()).toBe("header-value:request-value");
    });
  });
  it("honors aborts before headers and during response bodies", async () => {
    await withServer(async (base) => {
      const beforeHeaders = new AbortController();
      const waiting = longRequestFetch(`${base}/delayed`, { signal: beforeHeaders.signal });
      beforeHeaders.abort();
      await expect(waiting).rejects.toMatchObject({ name: "AbortError" });

      const duringBody = new AbortController();
      const response = await longRequestFetch(`${base}/stream`, { signal: duringBody.signal });
      duringBody.abort();
      await expect(response.text()).rejects.toBeTruthy();
    });
  });
  it("bounds response bodies and validates local request inputs", async () => {
    await withServer(async (base) => {
      const response = await longRequestFetch(`${base}/large`, { headers: { Authorization: "Bearer private-token" } });
      await expect(response.text()).rejects.toThrow("Response body exceeds limit");
      await expect(longRequestFetch(`${base}/large-length`)).rejects.toThrow("Response body exceeds limit");
      await expect(longRequestFetch(`${base}/ok`, { body: new Uint8Array([1]) })).rejects.toThrow("body");
      await expect(longRequestFetch(`${base}/ok`, { headers: { Authorization: 42 } as unknown as HeadersInit })).rejects.toThrow("headers");
      const unsupported = await longRequestFetch("ftp://private-provider-detail").catch((error: unknown) => error);
      expect(String(unsupported)).not.toContain("private-provider-detail");
      const credentialUrl = await longRequestFetch("http://private-provider-detail@127.0.0.1").catch((error: unknown) => error);
      expect(String(credentialUrl)).not.toContain("private-provider-detail");
    });
  });
});
