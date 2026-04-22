import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb, initStandaloneDb } from "../src/db/client.js";
import { llmUsage } from "../src/db/schema.js";
import { LlmCredentialError, callLlm } from "../src/llm/client.js";

let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "recall-llm-client-"));
  return initStandaloneDb(join(dir, "client.db"));
}

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.PATH = "/nonexistent";
});

afterEach(() => {
  closeDb();
  if (fetchSpy) {
    fetchSpy.mockRestore();
    fetchSpy = null;
  }
});

function stubFetch(payload: unknown, ok = true, status = 200) {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: ok ? status : status || 500,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("callLlm — OpenAI", () => {
  it("round-trips chat completion and records usage", async () => {
    const db = freshDb();
    process.env.OPENAI_API_KEY = "sk-test";
    stubFetch({
      choices: [{ message: { content: "  compacted summary  " } }],
      usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
    });

    const res = await callLlm(db, {
      provider: "openai",
      system: "you are helpful",
      user: "summarize",
      task_kind: "compact",
      repo: "edihasaj/recall",
    });

    expect(res.text).toBe("compacted summary");
    expect(res.provider).toBe("openai");
    expect(res.model).toBe("gpt-4o-mini");
    expect(res.usage.total_tokens).toBe(160);
    expect(res.usage.cost_usd).toBeCloseTo(
      (120 / 1_000_000) * 0.15 + (40 / 1_000_000) * 0.6,
      8,
    );

    const rows = db.select().from(llmUsage).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("openai");
    expect(rows[0].repo).toBe("edihasaj/recall");
    expect(rows[0].ok).toBe(true);
  });
});

describe("callLlm — Anthropic", () => {
  it("parses content blocks and records usage", async () => {
    const db = freshDb();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    stubFetch({
      content: [
        { type: "text", text: "merge memories 1 and 2 → " },
        { type: "text", text: "keep 1" },
      ],
      usage: { input_tokens: 50, output_tokens: 25 },
    });

    const res = await callLlm(db, {
      provider: "anthropic",
      system: "maintenance",
      user: "dedupe",
      task_kind: "dedupe",
    });

    expect(res.text).toBe("merge memories 1 and 2 → keep 1");
    expect(res.usage.prompt_tokens).toBe(50);
    expect(res.usage.completion_tokens).toBe(25);
    expect(res.usage.total_tokens).toBe(75);

    const rows = db.select().from(llmUsage).all();
    expect(rows[0].model).toBe("claude-haiku-4-5-20251001");
  });
});

describe("callLlm — failure modes", () => {
  it("throws LlmCredentialError when no key is available", async () => {
    const db = freshDb();
    await expect(
      callLlm(db, { provider: "openai", system: "s", user: "u", task_kind: "dedupe" }),
    ).rejects.toBeInstanceOf(LlmCredentialError);
  });

  it("records a failed row when the HTTP call errors out", async () => {
    const db = freshDb();
    process.env.OPENAI_API_KEY = "sk-test";
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limited", { status: 429 }),
    );
    await expect(
      callLlm(db, { provider: "openai", system: "s", user: "u", task_kind: "dedupe" }),
    ).rejects.toThrow(/OpenAI 429/);

    const rows = db.select().from(llmUsage).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
    expect(rows[0].error).toMatch(/429/);
  });
});
