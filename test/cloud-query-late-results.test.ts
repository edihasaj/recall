import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initStandaloneDb, type RecallDb } from "../src/db/client.js";
import { withCloudQueryEnrichment, resetCloudQueryEnrichmentForTests } from "../src/cloud/query-enrichment.js";
import { setCloudQueryEnabled } from "../src/cloud/query-settings.js";
import { createMemory, rejectMemory } from "../src/models/memory.js";
import { makeService } from "./helpers/cloud-fakes.js";
import type { CompiledContext } from "../src/compiler/context.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  resetCloudQueryEnrichmentForTests();
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const fn of cleanup.splice(0).reverse()) fn();
});
async function setup() {
  const home = mkdtempSync("/tmp/recall-cloud-late-");
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, RECALL_DATA_DIR: join(home, ".recall"), PATH: "/usr/bin" };
  const { service } = makeService(env);
  await service.connect({ token: "fixture-token", optIn: true });
  const db = initStandaloneDb(join(env.RECALL_DATA_DIR, "recall.db"));
  cleanup.push(() => db.$client.close());
  setCloudQueryEnabled(true, env);
  vi.stubEnv("HOME", home); vi.stubEnv("RECALL_DATA_DIR", env.RECALL_DATA_DIR);
  return { db, env };
}
const local: CompiledContext = { text: "Local context.", token_estimate: 4,
  memories_included: [], memories_dropped: [], history_included: [], confidence_threshold: 0.6 };
const query = "Which Python package manager should I use?";
const req = { repo: "owner/repo", query_text: query };
const record = (extra = {}) => ({ externalId: "remote:uv", kind: "rule", status: "active", confidence: 0.99,
  content: "Use uv for Python dependency management.", semanticScore: 0.9,
  metadata: { recall: { scope: "repo", repo: "owner/repo" } }, ...extra });
const payload = (records = [record()]) => ({ enrichmentVersion: 1, memories: records });
const run = (db: RecallDb, question = query) => withCloudQueryEnrichment(db, { ...req, query_text: question }, async () => local);

it("keeps a late successful response for the next query without offline cooldown or a second request", async () => {
  const { db } = await setup();
  let resolve!: (value: Response) => void;
  const mock = vi.fn(() => new Promise<Response>((r) => { resolve = r; }));
  vi.stubGlobal("fetch", mock);
  const start = performance.now();
  expect((await run(db)).cloud_enrichment?.status).toBe("pending");
  expect(performance.now() - start).toBeLessThan(300);
  expect(mock.mock.calls).toHaveLength(1);
  resolve(new Response(JSON.stringify(payload())));
  await new Promise((r) => setTimeout(r, 5));
  const ready = await run(db);
  expect(ready.cloud_enrichment).toMatchObject({ status: "ok", added: 1 });
  expect(ready.text).toContain("Use uv for Python dependency management.");
  expect(mock.mock.calls).toHaveLength(1);
});

it("joins the same pending lookup and delivers a server-scored paraphrase", async () => {
  const { db } = await setup();
  const mock = vi.fn(async () => { await new Promise((r) => setTimeout(r, 200));
    return new Response(JSON.stringify(payload([record({ content: "Prefer uv to install dependencies." })]))); });
  vi.stubGlobal("fetch", mock);
  expect((await run(db)).cloud_enrichment?.status).toBe("pending");
  const second = await run(db);
  expect(second.cloud_enrichment).toMatchObject({ status: "ok", added: 1 });
  expect(mock).toHaveBeenCalledTimes(1);
});

it("does not treat confidence or synced score metadata as query relevance", async () => {
  const { db } = await setup();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload([
    record({ semanticScore: 0.76 }),
    record({ externalId: "forged", semanticScore: undefined, metadata: {
      semanticScore: 1, recall: { scope: "global", repo: null, semanticScore: 1 },
    } }),
  ])))));
  const result = await run(db, "How can I bake sourdough bread at home?");
  expect(result.text).toBe(local.text);
  expect(result.cloud_enrichment?.added).toBe(0);
});

it("allows strong lexical results from older Cloud versions without accepting unrelated records", async () => {
  const { db } = await setup();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ memories: [record({ semanticScore: 1 })] }))));
  expect((await run(db)).cloud_enrichment?.added).toBe(1);
  expect((await run(db, "How can I bake sourdough bread at home?")).text).toBe(local.text);
});

it("can use a late result for a new lexically relevant query but never reuses its old semantic score", async () => {
  const { db } = await setup();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload()))));
  await run(db);
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  expect((await run(db, "uv")).cloud_enrichment?.added).toBe(1);
  const unrelated = await run(db, "How can I bake sourdough bread at home?");
  expect(unrelated.cloud_enrichment?.added).toBe(0);
  expect(unrelated.text).toBe(local.text);
});

it("rechecks local rejection before using cached Cloud copies", async () => {
  const { db } = await setup();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload()))));
  expect((await run(db)).cloud_enrichment?.added).toBe(1);
  const id = createMemory(db, { type: "rule", scope: "repo", repo: req.repo, source: "user_correction",
    confidence: 0.99, text: record().content });
  rejectMemory(db, id);
  expect((await run(db)).cloud_enrichment?.added).toBe(0);
});

it("isolates cached replies by consent generation, repository and expiration", async () => {
  const { db, env } = await setup();
  const mock = vi.fn(async () => new Response(JSON.stringify(payload())));
  vi.stubGlobal("fetch", mock);
  await run(db);
  await withCloudQueryEnrichment(db, { ...req, repo: "foreign/repo" }, async () => local);
  expect(mock).toHaveBeenCalledTimes(2);
  setCloudQueryEnabled(false, env);
  expect(await run(db)).toBe(local);
  setCloudQueryEnabled(true, env);
  await run(db);
  expect(mock).toHaveBeenCalledTimes(3);
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
  await run(db);
  expect(mock).toHaveBeenCalledTimes(4);
  vi.restoreAllMocks();
});

it("expires a genuinely hung request at the network deadline and applies cooldown", async () => {
  const { db } = await setup();
  let signal: AbortSignal | null | undefined;
  const mock = vi.fn((_url, init: RequestInit) => { signal = init.signal; return new Promise(() => {}); });
  vi.stubGlobal("fetch", mock);
  expect((await run(db)).cloud_enrichment?.status).toBe("pending");
  await new Promise((r) => setTimeout(r, 3100));
  expect(signal?.aborted).toBe(true);
  expect((await run(db)).cloud_enrichment?.status).toBe("unavailable");
  expect(mock).toHaveBeenCalledTimes(1);
});

it("prioritizes the exact cached question over newer overlapping questions", async () => {
  const { db } = await setup();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload()))));
  await run(db);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload(
    Array.from({ length: 12 }, (_, i) => record({ externalId: `foreign:${i}`, content: `Python package manager preference ${i}.`,
      metadata: { recall: { scope: "repo", repo: "foreign/repo" } } })),
  )))));
  await run(db, "Which Python package manager is preferred?");
  const result = await run(db);
  expect(result.text).toContain("Use uv for Python dependency management.");
  expect(result.cloud_enrichment?.added).toBe(1);
});

it("cancels one-shot lookups at the short wait instead of keeping CLI hooks alive", async () => {
  const { db } = await setup();
  const { setCloudQueryBackgroundEnabled } = await import("../src/cloud/query-lookup.js");
  setCloudQueryBackgroundEnabled(false);
  let signal: AbortSignal | undefined | null;
  vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => { signal = init.signal;
    return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))); }));
  const start = performance.now();
  expect((await run(db)).cloud_enrichment?.status).toBe("timeout");
  expect(signal?.aborted).toBe(true);
  expect(performance.now() - start).toBeLessThan(300);
});
