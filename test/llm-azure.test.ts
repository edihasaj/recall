import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb, initStandaloneDb } from "../src/db/client.js";
import { llmUsage } from "../src/db/schema.js";
import { LlmCredentialError, callLlm } from "../src/llm/client.js";

let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "recall-llm-azure-"));
  return initStandaloneDb(join(dir, "azure.db"));
}

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_DEPLOYMENT;
  delete process.env.AZURE_OPENAI_API_VERSION;
  delete process.env.AZURE_OPENAI_API_KEY;
  process.env.PATH = "/nonexistent";
});

afterEach(() => {
  closeDb();
  if (fetchSpy) {
    fetchSpy.mockRestore();
    fetchSpy = null;
  }
});

describe("Azure OpenAI provider", () => {
  it("throws LlmCredentialError when azure vars are missing", async () => {
    const db = freshDb();
    await expect(
      callLlm(db, {
        provider: "azure-openai",
        system: "s",
        user: "u",
        task_kind: "dedupe",
      }),
    ).rejects.toBeInstanceOf(LlmCredentialError);
  });

  it("calls the Azure URL template with api-key header when env is set", async () => {
    const db = freshDb();
    process.env.AZURE_OPENAI_ENDPOINT = "https://myresource.openai.azure.com";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-4o-mini";
    process.env.AZURE_OPENAI_API_VERSION = "2024-10-21";
    process.env.AZURE_OPENAI_API_KEY = "az-test-key";

    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const res = await callLlm(db, {
      provider: "azure-openai",
      system: "s",
      user: "u",
      task_kind: "dedupe",
    });

    expect(res.provider).toBe("azure-openai");
    expect(res.model).toBe("gpt-4o-mini");
    expect(res.text).toBe("ok");

    const callArgs = fetchSpy!.mock.calls[0];
    const url = callArgs[0] as string;
    const init = callArgs[1] as RequestInit;
    expect(url).toBe(
      "https://myresource.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-10-21",
    );
    const headers = init.headers as Record<string, string>;
    expect(headers["api-key"]).toBe("az-test-key");
    expect(headers["Authorization"]).toBeUndefined();
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body as string);
    expect(body.model).toBeUndefined(); // Azure uses deployment in the URL
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual({ role: "system", content: "s" });
  });

  it("rejects non-Azure credential destinations before fetch", async () => {
    const db = freshDb();
    process.env.AZURE_OPENAI_ENDPOINT = "https://metadata.example.com";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-4o-mini";
    process.env.AZURE_OPENAI_API_VERSION = "2024-10-21";
    process.env.AZURE_OPENAI_API_KEY = "az-test-key";
    fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      callLlm(db, {
        provider: "azure-openai",
        system: "s",
        user: "u",
        task_kind: "dedupe",
      }),
    ).rejects.toBeInstanceOf(LlmCredentialError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("trims trailing slash in endpoint and URL-encodes deployment name", async () => {
    const db = freshDb();
    process.env.AZURE_OPENAI_ENDPOINT = "https://myresource.openai.azure.com/";
    process.env.AZURE_OPENAI_DEPLOYMENT = "my deployment";
    process.env.AZURE_OPENAI_API_VERSION = "2024-10-21";
    process.env.AZURE_OPENAI_API_KEY = "k";

    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await callLlm(db, {
      provider: "azure-openai",
      system: "s",
      user: "u",
      task_kind: "dedupe",
    });

    const url = fetchSpy!.mock.calls[0][0] as string;
    expect(url).toBe(
      "https://myresource.openai.azure.com/openai/deployments/my%20deployment/chat/completions?api-version=2024-10-21",
    );
  });

  it("records azure-openai provider in llm_usage on failure", async () => {
    const db = freshDb();
    process.env.AZURE_OPENAI_ENDPOINT = "https://myresource.openai.azure.com";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-4o-mini";
    process.env.AZURE_OPENAI_API_VERSION = "2024-10-21";
    process.env.AZURE_OPENAI_API_KEY = "k";

    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("auth failed", { status: 401 }),
    );

    await expect(
      callLlm(db, {
        provider: "azure-openai",
        system: "s",
        user: "u",
        task_kind: "dedupe",
      }),
    ).rejects.toThrow(/Azure OpenAI 401/);

    const rows = db.select().from(llmUsage).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("azure-openai");
    expect(rows[0].ok).toBe(false);
  });
});
