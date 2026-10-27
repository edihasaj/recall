import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { initStandaloneDb, type RecallDb } from "../src/db/client.js";
import { createMemory, rejectMemory } from "../src/models/memory.js";
import { resolveCloudPaths } from "../src/cloud/paths.js";
import { setCloudQueryEnabled } from "../src/cloud/query-settings.js";
import { withCloudQueryEnrichment, resetCloudQueryEnrichmentForTests } from "../src/cloud/query-enrichment.js";
import { resetQueryDedupeWorkerForTests, setQueryDedupeWorkerFactoryForTests } from "../src/cloud/query-dedupe.js";
import { makeService } from "./helpers/cloud-fakes.js";
import type { CompiledContext, CompileRequest } from "../src/compiler/context.js";

const cleanups: string[] = [];
const originalHome = process.env.HOME;
const originalDataDir = process.env.RECALL_DATA_DIR;

function local(text = "# Recall: owner/repo\n\n## Rules\n- Keep local text.\n", tokens = 14): CompiledContext {
  return {
    text,
    token_estimate: tokens,
    memories_included: ["local-id"],
    memories_dropped: [],
    history_included: [],
    confidence_threshold: 0.6,
  };
}

async function configured(): Promise<{ db: RecallDb; env: NodeJS.ProcessEnv }> {
  const home = mkdtempSync("/tmp/recall-cloud-query-enrichment-");
  cleanups.push(home);
  const env = { HOME: home, RECALL_DATA_DIR: join(home, ".recall"), PATH: "/usr/bin" };
  const { service } = makeService(env);
  await service.connect({ token: `token-${home}`, optIn: true });
  const paths = resolveCloudPaths(env);
  const db = initStandaloneDb(paths.dbFile);
  setCloudQueryEnabled(true, env);
  process.env.HOME = env.HOME;
  process.env.RECALL_DATA_DIR = env.RECALL_DATA_DIR;
  return { db, env };
}

function request(config: CompileRequest["config"] = {}): CompileRequest {
  return { repo: "owner/repo", query_text: "How should I ship this?", config };
}

function cloudRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "other-device:remote-1",
    status: "active",
    kind: "rule",
    confidence: 0.9,
    semanticScore: 0.95,
    content: "Run the focused test before the full gate.",
    metadata: {
      localMemoryId: "remote-local-id",
      recall: { type: "rule", scope: "repo", repo: "owner/repo" },
    },
    ...overrides,
  };
}

function seedLargeDb(db: RecallDb, count: number): void {
  const now = new Date().toISOString();
  const insert = db.$client.prepare(`
    INSERT INTO memories (id, type, text, scope, repo, status, confidence, source, evidence, created_at, updated_at, auto_inject)
    VALUES (?, 'rule', ?, 'repo', 'owner/repo', 'active', 0.9, 'user_correction', '[]', ?, ?, 1)
  `);
  db.$client.transaction(() => {
    for (let index = 0; index < count; index += 1) insert.run(`large-${index}`, `Large local row ${index}`, now, now);
  })();
}

beforeEach(() => {
  resetCloudQueryEnrichmentForTests();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetCloudQueryEnrichmentForTests();
  resetQueryDedupeWorkerForTests();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDataDir === undefined) delete process.env.RECALL_DATA_DIR;
  else process.env.RECALL_DATA_DIR = originalDataDir;
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("optional cloud query enrichment", () => {
  it("starts the bounded request before local work, sends only allowed knobs, and appends evidence", async () => {
    const { db } = await configured();
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ enrichmentVersion: 1,
      memories: [cloudRecord()],
      sources: [{ sourceId: "other\nrepo", content: { observation: "unrelated aggregate evidence" } }],
    })));
    let sawFetchBeforeLocal = false;

    const result = await withCloudQueryEnrichment(db, request(), async () => {
      sawFetchBeforeLocal = fetchMock.mock.calls.length === 1;
      return local();
    });

    expect(sawFetchBeforeLocal).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.recallmemory.dev/v1/compile");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "How should I ship this?", retrievalMode: "auto", status: "active", limit: 12,
      contextChars: 1000, perSourceChars: 256, supplementalSources: 0,
      semanticSupplementalSources: 0, relevance: false, clientEnrichment: true,
    });
    expect(result.text.startsWith(local().text)).toBe(true);
    expect(result.text).toContain("Run the focused test before the full gate.");
    expect(result.text).toContain("## CloudEvidence");
    expect(result.text).toContain('source "other-device:remote-1"; kind rule; scope repo');
    expect(result.text).not.toContain("unrelated aggregate evidence");
    expect(result.memories_included).toEqual(["local-id"]);
    expect(result.cloud_enrichment).toMatchObject({ status: "ok", added: 1 });
  });

  it("cleans up its single abort listener after a multi-chunk body", async () => {
    const { db } = await configured();
    const body = JSON.stringify({ enrichmentVersion: 1, memories: [cloudRecord()] });
    const encoder = new TextEncoder();
    const add = vi.spyOn(AbortSignal.prototype, "addEventListener");
    const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener");
    vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        for (let index = 0; index < body.length; index += 7) controller.enqueue(encoder.encode(body.slice(index, index + 7)));
        controller.close();
      },
    })));

    await withCloudQueryEnrichment(db, request(), async () => local());

    const abortAdds = add.mock.calls.filter(([name]) => name === "abort");
    const abortRemoves = remove.mock.calls.filter(([name]) => name === "abort");
    expect(abortAdds).toHaveLength(1);
    expect(abortRemoves).toHaveLength(1);
  });

  it("leaves local compilation exactly unchanged when query enrichment is off or there is no query", async () => {
    const { db, env } = await configured();
    setCloudQueryEnabled(false, env);
    const value = local();
    await expect(withCloudQueryEnrichment(db, request(), async () => value)).resolves.toBe(value);
    await expect(withCloudQueryEnrichment(db, { ...request(), query_text: undefined }, async () => value)).resolves.toBe(value);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("redacts secrets only from the outbound cloud question", async () => {
    const { db } = await configured();
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ enrichmentVersion: 1, memories: [] })));
    const query = "Inspect sk-abcdefghijklmnop without changing local retrieval.";

    await withCloudQueryEnrichment(db, { ...request(), query_text: query }, async () => local());

    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(JSON.parse(String(init?.body)).query).toBe("Inspect [REDACTED] without changing local retrieval.");
  });

  it("accepts only matching repo/global durable active records and never resurrects local rows", async () => {
    const { db } = await configured();
    const rejected = createMemory(db, {
      type: "rule", text: "Rejected local memory.", scope: "repo", repo: "owner/repo",
      source: "user_correction", confidence: 0.9,
    });
    rejectMemory(db, rejected);
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ enrichmentVersion: 1, memories: [
      cloudRecord({ content: "Matching repo rule." }),
      cloudRecord({ id: "global", content: "Global rule.", metadata: { recall: { type: "rule", scope: "global", repo: null } } }),
      cloudRecord({ id: "team", content: "Team rule.", metadata: { recall: { type: "rule", scope: "team", repo: "owner/repo" } } }),
      cloudRecord({ id: "foreign", content: "Foreign rule.", metadata: { recall: { type: "rule", scope: "repo", repo: "other/repo" } } }),
      cloudRecord({ id: "candidate", status: "candidate", content: "Candidate cloud rule." }),
      cloudRecord({ id: "rejected", content: "Rejected local memory.", metadata: { recall: { type: "rule", scope: "repo", repo: "owner/repo" } } }),
      cloudRecord({ id: "same-id", metadata: { localMemoryId: rejected, recall: { type: "rule", scope: "repo", repo: "owner/repo" } } }),
    ] })));

    const result = await withCloudQueryEnrichment(db, request({ token_budget: 500 }), async () => local());

    expect(result.text).toContain("Matching repo rule.");
    expect(result.text).toContain("Global rule.");
    expect(result.text).not.toContain("Team rule.");
    expect(result.text).not.toContain("Foreign rule.");
    expect(result.text).not.toContain("Candidate cloud rule.");
    expect(result.text).not.toContain("Rejected local memory.");
    expect(result.cloud_enrichment).toMatchObject({ status: "ok", added: 2 });
    expect(db.$client.prepare("SELECT count(*) AS count FROM memories").get()).toMatchObject({ count: 1 });
  });

  it("deduplicates exact local text and keeps whole cloud records inside remaining budget", async () => {
    const { db } = await configured();
    createMemory(db, {
      type: "rule", text: "Already local.", scope: "repo", repo: "owner/repo",
      source: "user_correction", confidence: 0.9,
    });
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ enrichmentVersion: 1, memories: [
      cloudRecord({ content: "Already local." }),
      cloudRecord({ id: "short", content: "Keep the short cloud rule." }),
      cloudRecord({ id: "long", content: "x".repeat(2_000) }),
    ] })));

    const result = await withCloudQueryEnrichment(db, request({ token_budget: 250 }), async () => local("local", 12));

    expect(result.text).toContain("Keep the short cloud rule.");
    expect(result.text).not.toContain("Already local.");
    expect(result.text).not.toContain("x".repeat(200));
    expect(result.cloud_enrichment).toMatchObject({ added: 1 });
    expect(result.token_estimate).toBeLessThanOrEqual(250);
  });

  it("uses the resolved local threshold, normalizes rejected local text, and preserves whole cloud content", async () => {
    const { db } = await configured();
    const rejected = createMemory(db, {
      type: "rule", text: "Do   not\nresurrect this memory.", scope: "repo", repo: "owner/repo",
      source: "user_correction", confidence: 0.9,
    });
    rejectMemory(db, rejected);
    const headingContent = "Keep the complete condition.\n## Rules\n- This heading stays quoted.";
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ enrichmentVersion: 1, memories: [
      cloudRecord({ id: "below-adaptive", confidence: 0.7, content: "Below the actual adaptive threshold." }),
      cloudRecord({ id: "rejected-copy", content: "Do not resurrect this memory." }),
      cloudRecord({ id: "whole-content", content: headingContent }),
    ] })));

    const result = await withCloudQueryEnrichment(db, request({ token_budget: 1_000 }), async () => ({
      ...local(), confidence_threshold: 0.82,
    }));

    expect(result.text).not.toContain("Below the actual adaptive threshold.");
    expect(result.text).not.toContain("Do not resurrect this memory.");
    expect(result.text).toContain(JSON.stringify(headingContent));
    expect(result.cloud_enrichment).toMatchObject({ added: 1 });
  });

  it("does not append partial sections when the remaining budget cannot fit headers and quotes", async () => {
    const { db } = await configured();
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ enrichmentVersion: 1,
      memories: [cloudRecord({ content: "x" })],
    })));
    const original = local("local", 12);

    const result = await withCloudQueryEnrichment(db, request({ token_budget: 20 }), async () => original);

    expect(result.text).toBe(original.text);
    expect(result.cloud_enrichment).toMatchObject({ status: "ok", added: 0 });
  });

  it("returns promptly for offline, unauthorized, hanging and oversized responses", async () => {
    const { db } = await configured();
    vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
    expect((await withCloudQueryEnrichment(db, request(), async () => local())).cloud_enrichment?.status).toBe("unavailable");
    await withCloudQueryEnrichment(db, request(), async () => local());
    expect(fetch).toHaveBeenCalledTimes(1);

    resetCloudQueryEnrichmentForTests();
    vi.mocked(fetch).mockResolvedValueOnce(new Response("denied", { status: 401 }));
    expect((await withCloudQueryEnrichment(db, request(), async () => local())).cloud_enrichment?.status).toBe("unavailable");

    resetCloudQueryEnrichmentForTests();
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => {}));
    const started = Date.now();
    const hungHeaders = await withCloudQueryEnrichment(db, request(), async () => local());
    expect(hungHeaders.cloud_enrichment?.status).toBe("pending");
    expect(Date.now() - started).toBeLessThanOrEqual(300);

    resetCloudQueryEnrichmentForTests();
    let oversizedCancelled = false;
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new ReadableStream({
      cancel() { oversizedCancelled = true; },
    }), { headers: { "content-length": String(256 * 1024 + 1) } }));
    expect((await withCloudQueryEnrichment(db, request(), async () => local())).cloud_enrichment?.status).toBe("unavailable");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(oversizedCancelled).toBe(true);
  });

  it("does not let a slow cloud request delay local failures and aborts it", async () => {
    const { db } = await configured();
    let aborted = false;
    vi.mocked(fetch).mockImplementationOnce((_url, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
    }));

    await expect(withCloudQueryEnrichment(db, request(), async () => {
      throw new Error("local failed");
    })).rejects.toThrow("local failed");
    expect(aborted).toBe(true);
  });

  it("aborts a hanging body and discards a response after query consent is revoked", async () => {
    const { db, env } = await configured();
    let cancelled = false;
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new ReadableStream({
      cancel() { cancelled = true; },
    })));
    const bodyResult = await withCloudQueryEnrichment(db, request(), async () => local());
    expect(bodyResult.cloud_enrichment?.status).toBe("pending");
    await new Promise((resolve) => setTimeout(resolve, 3_100));
    expect(cancelled).toBe(true);

    resetCloudQueryEnrichmentForTests();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ enrichmentVersion: 1, memories: [cloudRecord()] })));
    const original = local();
    const revoked = await withCloudQueryEnrichment(db, request(), async () => {
      setCloudQueryEnabled(false, env);
      return original;
    });
    expect(revoked).toBe(original);
  });

  it("limits concurrent requests and returns local context after the 150ms cloud grace window", async () => {
    const { db } = await configured();
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const first = withCloudQueryEnrichment(db, request(), async () => local());
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await withCloudQueryEnrichment(db, request(), async () => local("second"));
    expect(second.cloud_enrichment).toMatchObject({ status: "pending", added: 0 });
    const started = Date.now();
    const firstResult = await first;
    expect(firstResult.cloud_enrichment?.status).toBe("pending");
    expect(Date.now() - started).toBeLessThanOrEqual(300);
    finish(new Response(JSON.stringify({ enrichmentVersion: 1, memories: [] })));
  });

  it("shares one 150ms post-local deadline across delayed cloud and hung dedupe work", async () => {
    const { db } = await configured();
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => {
      setTimeout(() => resolve(new Response(JSON.stringify({ enrichmentVersion: 1, memories: [cloudRecord()] }))), 200);
    }));
    const delayedStarted = Date.now();
    const delayed = await withCloudQueryEnrichment(db, request(), async () => local());
    expect(delayed.cloud_enrichment?.status).toBe("pending");
    expect(Date.now() - delayedStarted).toBeLessThanOrEqual(300);

    resetCloudQueryEnrichmentForTests();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ enrichmentVersion: 1, memories: [cloudRecord()] })));
    let spawnedWorkers = 0;
    setQueryDedupeWorkerFactoryForTests(() => {
      spawnedWorkers += 1;
      return { once: () => undefined, terminate: () => new Promise<number>(() => undefined) };
    });
    const hungStarted = Date.now();
    const hung = await withCloudQueryEnrichment(db, request(), async () => local());
    expect(hung.text).toBe(local().text);
    expect(hung.cloud_enrichment?.status).toBe("timeout");
    expect(Date.now() - hungStarted).toBeLessThanOrEqual(300);

    resetCloudQueryEnrichmentForTests();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ enrichmentVersion: 1, memories: [cloudRecord()] })));
    const busyStarted = Date.now();
    const busy = await withCloudQueryEnrichment(db, request(), async () => local());
    expect(busy.cloud_enrichment?.status).toBe("unavailable");
    expect(Date.now() - busyStarted).toBeLessThanOrEqual(300);
    expect(spawnedWorkers).toBe(1);
  });

  it("does not synchronously scan a large local corpus during cloud dedupe", async () => {
    const { db } = await configured();
    seedLargeDb(db, 4_000);
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ enrichmentVersion: 1,
      memories: [cloudRecord({ content: "Large local row 3999" })],
    })));
    const started = Date.now();
    const result = await withCloudQueryEnrichment(db, request(), async () => local());

    expect(result.text).not.toContain("Large local row 3999");
    expect(["ok", "timeout"]).toContain(result.cloud_enrichment?.status);
    expect(Date.now() - started).toBeLessThanOrEqual(300);
  });
});
