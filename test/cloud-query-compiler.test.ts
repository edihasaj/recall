import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initStandaloneDb } from "../src/db/client.js";
import { compileContextHybrid } from "../src/compiler/context.js";
import { setCloudQueryEnabled } from "../src/cloud/query-settings.js";
import { resolveCloudPaths } from "../src/cloud/paths.js";
import { resetCloudQueryEnrichmentForTests } from "../src/cloud/query-enrichment.js";
import { handlePromptHook } from "../src/cli/hook.js";
import { makeService } from "./helpers/cloud-fakes.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetCloudQueryEnrichmentForTests();
  for (const fn of cleanups.splice(0).reverse()) fn();
});

it("delivers Cloud-only context through the real shared compiler and prompt hook", async () => {
  const home = mkdtempSync("/tmp/recall-cloud-query-compiler-");
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, RECALL_DATA_DIR: join(home, ".recall"), PATH: "/usr/bin" };
  const { service } = makeService(env);
  await service.connect({ token: "tok_compiler_fixture", optIn: true });
  const db = initStandaloneDb(resolveCloudPaths(env).dbFile);
  cleanups.push(() => db.$client.close());
  setCloudQueryEnabled(true, env);
  vi.stubEnv("HOME", env.HOME);
  vi.stubEnv("RECALL_DATA_DIR", env.RECALL_DATA_DIR);
  vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "true");
  vi.stubEnv("RECALL_HOOK_INJECT_PROMPT", "true");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    memories: [{ externalId: "remote-device:memory", kind: "rule", status: "active",
      content: "Use the migration dry-run before schema changes.", confidence: 0.99,
      metadata: { localMemoryId: "remote-memory", recall: { scope: "repo", repo: "owner/project" } } }],
  }))));
  const compiled = await compileContextHybrid(db, { repo: "owner/project", query_text: "How do I change the schema?" });
  expect(compiled.text).toContain("Use the migration dry-run before schema changes.");
  expect(compiled.cloud_enrichment).toMatchObject({ status: "ok", added: 1 });
  expect(compiled.memories_included).toEqual([]);
  const hooked = await handlePromptHook({ repo: "owner/project", session_id: "cloud-session",
    text: "How do I change the schema?", agent: "claude-code" }, db);
  expect(hooked.injection?.text).toContain("Use the migration dry-run before schema changes.");
  expect(db.$client.prepare("SELECT count(*) AS count FROM memories").get()).toEqual({ count: 0 });
});
