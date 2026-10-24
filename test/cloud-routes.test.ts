import { createServer, type Server } from "node:http";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { handleCloudRoute } from "../src/cloud/routes.js";
import { JsonBodyError } from "../src/daemon/body.js";
import { TOKEN, makeHome, makeService } from "./helpers/cloud-fakes.js";

const servers: Server[] = [];
const homes: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

async function start() {
  const h = makeHome();
  homes.push(h.home);
  const { service, worker } = makeService(h.env);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (!(await handleCloudRoute(service, req, res, url.pathname, req.method ?? "GET"))) {
        res.statusCode = 404;
        res.end("{}");
      }
    } catch (e) {
      res.statusCode = e instanceof JsonBodyError ? e.status : 500;
      res.end("{}");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, worker };
}

describe("cloud routes", () => {
  it("reports disconnected status without starting anything", async () => {
    const { base, worker } = await start();
    const res = await fetch(`${base}/cloud/status`);
    expect((await res.json()).state).toBe("disconnected");
    expect(worker.launches).toHaveLength(0);
  });

  it("connects, never echoes the token, and disconnects", async () => {
    const { base, worker } = await start();
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });
    const noOptIn = await post("/cloud/connect", { token: TOKEN });
    expect(noOptIn.status).toBe(400);
    expect((await noOptIn.json()).code).toBe("opt-in-required");
    const ok = await post("/cloud/connect", { token: TOKEN, optIn: true });
    const text = await ok.text();
    expect(ok.status).toBe(200);
    expect(text).not.toContain(TOKEN);
    expect(worker.launches).toHaveLength(1);
    const off = await post("/cloud/disconnect", {});
    expect((await off.json()).state).toBe("disconnected");
  });

  it("rejects malformed bodies and unknown cloud paths", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/cloud/connect`, { method: "POST", body: "{nope" })).status).toBe(400);
    expect((await fetch(`${base}/cloud/other`)).status).toBe(404);
    expect((await fetch(`${base}/cloud/connect`)).status).toBe(404);
  });
});
