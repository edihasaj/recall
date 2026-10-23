import { describe, expect, it } from "vitest";
import { callQwenLocal, LocalModelError, validateLocalBaseUrl } from "../benchmark/temporal-model.js";

describe("qwen-local temporal adapter", () => {
  it("uses loopback Responses and maps text and usage", async () => {
    let request: RequestInit | undefined;
    const answer = await callQwenLocal({ system: "system", user: "user", reasoning_effort: "none" }, {
      env: { DGX_BASE_URL: "http://127.0.0.1:8010/v1", DGX_KEY_FILE: "/tmp/qwen-token" },
      readFile: () => " token ", now: (() => { let n = 10; return () => n += 5; })(),
      fetch: async (_url, init) => { request = init; return new Response(JSON.stringify({ output_text: "{\"values\":[]}", model: "qwen-test", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } })); },
    });
    expect(answer).toMatchObject({ provider: "qwen-local", model: "qwen-test", text: '{"values":[]}', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost_usd: null } });
    expect(request?.redirect).toBe("error");
    expect(JSON.parse(request?.body as string)).toMatchObject({ max_output_tokens: 512, reasoning: { effort: "none" }, temperature: 0, store: false });
  });

  it("rejects public or credential-bearing destinations before a request", () => {
    for (const url of ["https://127.0.0.1/v1", "http://example.com/v1", "http://user@127.0.0.1/v1", "http://127.0.0.1/v1?x=1", "http://127.0.0.1/other"]) {
      expect(() => validateLocalBaseUrl(url)).toThrow(LocalModelError);
    }
  });

  it("redacts response bodies and classifies HTTP, timeout, and malformed payload errors", async () => {
    const base = { env: { DGX_BASE_URL: "http://localhost:9010/v1", DGX_KEY_FILE: "/tmp/qwen-token" }, readFile: () => "token" };
    await expect(callQwenLocal({ system: "s", user: "u" }, { ...base, fetch: async () => new Response("secret body", { status: 429 }) })).rejects.toThrow("HTTP 429");
    await expect(callQwenLocal({ system: "s", user: "u" }, { ...base, fetch: async () => { throw new DOMException("slow", "TimeoutError"); } })).rejects.toThrow("timeout");
    await expect(callQwenLocal({ system: "s", user: "u" }, { ...base, fetch: async () => new Response("{}") })).rejects.toThrow("malformed response");
  });

  it("rejects non-completed Responses payloads before accepting output text", async () => {
    const base = { env: { DGX_BASE_URL: "http://localhost:9010/v1", DGX_KEY_FILE: "/tmp/qwen-token" }, readFile: () => "token" };
    for (const payload of [
      { status: "failed", error: { message: "secret" }, output_text: "{\"values\":[]}" },
      { status: "incomplete", output_text: "{\"values\":[]}" },
      { status: "cancelled", output_text: "{\"values\":[]}" },
      { status: "in_progress", output_text: "{\"values\":[]}" },
      { error: { message: "secret" }, output_text: "{\"values\":[]}" },
      { output: null },
      { output: [{ content: null }] },
      { output_text: "{\"values\":[]}", usage: { input_tokens: -1 } },
      { output_text: "{\"values\":[]}", usage: { output_tokens: 1.5 } },
    ]) {
      await expect(callQwenLocal({ system: "s", user: "u" }, { ...base, fetch: async () => new Response(JSON.stringify(payload)) })).rejects.toThrow(LocalModelError);
    }
  });

  it("keeps missing usage explicitly unknown without inventing counters", async () => {
    const answer = await callQwenLocal({ system: "s", user: "u" }, {
      env: { DGX_BASE_URL: "http://localhost:9010/v1", DGX_KEY_FILE: "/tmp/qwen-token" },
      readFile: () => "token",
      fetch: async () => new Response(JSON.stringify({ output_text: "{\"values\":[]}" })),
    });
    expect(answer.usage).toEqual({ prompt_tokens: null, completion_tokens: null, total_tokens: null, cost_usd: null });
  });
});
