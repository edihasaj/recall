import { describe, expect, it, vi } from "vitest";
import {
  AZURE_ANSWER_SYSTEM,
  createAzureAnswerCall,
  type AzureAnswerConfig,
} from "../benchmark/longmemeval-azure-answer.js";
import { parseAnswer, sha256 } from "../benchmark/longmemeval-qa-support.js";

const KEY = "azure-secret-key-DO-NOT-LEAK";
const PROMPT = "Question: Which pottery activity does Nila prefer?\n## Memory 1\nuser: pottery";

function config(overrides: Partial<AzureAnswerConfig> = {}): AzureAnswerConfig {
  return {
    endpoint: "https://recall-eval.openai.azure.com",
    deployment: "gpt-5.6-sol-1",
    key: KEY,
    answerInstructions: "Use every supplied source before answering.",
    ...overrides,
  };
}

type Recorded = { url: string; init: RequestInit };

function responder(respond: (call: number) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  let count = 0;
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    count += 1;
    calls.push({ url, init });
    return respond(count);
  });
  return { calls, fetch: fetchImpl };
}

const json = (payload: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(payload), { status: 200, ...init });

const completed = (text: string, extra: Record<string, unknown> = {}) => json({
  status: "completed", model: "gpt-5.6-sol", ...extra,
  output: [{ type: "message", content: [{ type: "output_text", text }] }],
});

const answer = (reasoning: string, value: string) => JSON.stringify({ reasoning, answer: value });

type RequestBody = {
  input: { role: string; content: string }[];
  max_output_tokens: number;
  model: string;
  reasoning: { effort: string };
  store: boolean;
  text: unknown;
};

function harness(
  respond: (call: number) => Response | Promise<Response>,
  overrides: Partial<AzureAnswerConfig> = {},
  wait: (ms: number) => Promise<void> = async () => {},
) {
  const waits: number[] = [];
  const provider = responder(respond);
  const call = createAzureAnswerCall(config(overrides), {
    fetch: provider.fetch,
    wait: async (ms) => { waits.push(ms); await wait(ms); },
  });
  return { ...provider, waits, call };
}

describe("Azure Responses answer adapter", () => {
  it("sends the exact Responses request, strict schema, settings and prompt", async () => {
    const { calls, call } = harness(() => completed(answer("because pottery", "Pottery")));
    const result = await call(PROMPT);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://recall-eval.openai.azure.com/openai/v1/responses");
    const init = calls[0]!.init;
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({ "Content-Type": "application/json", "api-key": KEY });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(AZURE_ANSWER_SYSTEM).toBe("Return only JSON with reasoning and answer string fields.");
    const body = JSON.parse(String(init.body)) as RequestBody;
    expect(Object.keys(body).sort()).toEqual(["input", "max_output_tokens", "model", "reasoning", "store", "text"]);
    expect(body.model).toBe("gpt-5.6-sol-1");
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: "medium" });
    expect(body.max_output_tokens).toBe(16_384);
    expect(body.text).toEqual({
      format: {
        type: "json_schema", name: "benchmark_answer", strict: true,
        schema: {
          type: "object",
          properties: { reasoning: { type: "string" }, answer: { type: "string" } },
          required: ["reasoning", "answer"],
          additionalProperties: false,
        },
      },
    });
    expect(body.input).toEqual([
      { role: "system", content: `${AZURE_ANSWER_SYSTEM}\n\nUse every supplied source before answering.` },
      { role: "user", content: PROMPT },
    ]);
    expect(result).toMatchObject({
      error: null, model: "gpt-5.6-sol", attempts: 1,
      prompt_sha256: sha256(PROMPT),
      request_config: { reasoning_effort: "medium", max_output_tokens: 16_384 },
    });
    expect(result.text).toBe(answer("because pottery", "Pottery"));
    expect(typeof result.elapsed_ms).toBe("number");
  });

  it("preserves configured instructions byte for byte after the fixed prefix", async () => {
    const instructions = " Keep \nthis  exact. ";
    const { calls, call } = harness(() => completed(answer("r", "a")), { answerInstructions: instructions });
    await call(PROMPT);
    const body = JSON.parse(String(calls[0]!.init.body)) as { input: { role: string; content: string }[] };
    expect(body.input[0]!.content).toBe(`${AZURE_ANSWER_SYSTEM}\n\n${instructions}`);
  });

  it("always uses the separator, even for empty instructions", async () => {
    const { calls, call } = harness(() => completed(answer("r", "a")), { answerInstructions: "" });
    await call(PROMPT);
    const body = JSON.parse(String(calls[0]!.init.body)) as { input: { role: string; content: string }[] };
    expect(body.input[0]!.content).toBe(`${AZURE_ANSWER_SYSTEM}\n\n`);
  });

  it("rejects missing instruction configuration before any request", () => {
    const fetch = vi.fn();
    expect(() => createAzureAnswerCall(
      config({ answerInstructions: undefined as unknown as string }), { fetch },
    )).toThrow("instructions must be a string");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts the explicit Responses path and records usage from top-level output_text", async () => {
    const { calls, call } = harness(() => json({
      status: "completed", output_text: answer("top level", "Glazing"),
      model: "gpt-5.6-sol", usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
    }), { endpoint: "https://recall-eval.cognitiveservices.azure.com/openai/v1/responses" });
    const result = await call(PROMPT);
    expect(calls[0]!.url).toBe("https://recall-eval.cognitiveservices.azure.com/openai/v1/responses");
    expect(result.text).toBe(answer("top level", "Glazing"));
    expect(result.usage).toEqual({ input_tokens: 9, output_tokens: 4, total_tokens: 13 });
    expect(result.model).toBe("gpt-5.6-sol");
  });

  it("keeps the deployment as the recorded model when none is returned", async () => {
    const { call } = harness(() => json({ status: "completed", output_text: answer("r", "a") }));
    expect((await call(PROMPT)).model).toBe("gpt-5.6-sol-1");
  });

  it("fails an incomplete response without salvage or retry but keeps usage", async () => {
    const { fetch, call } = harness(() => json({
      status: "incomplete", model: "gpt-5.6-sol", usage: { input_tokens: 5, output_tokens: 16_384 },
      output_text: "truncated",
    }));
    const result = await call(PROMPT);
    expect(result).toMatchObject({ text: null, error: "response_incomplete", attempts: 1, usage: { input_tokens: 5, output_tokens: 16_384 } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a provider error even with completed text, preserving usage without retry", async () => {
    const { fetch, call } = harness(() => json({
      status: "completed", error: { message: KEY }, output_text: answer("r", "a"),
      model: "gpt-5.6-sol", usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
    }));
    const result = await call(PROMPT);
    expect(result).toMatchObject({
      text: null, error: "response_not_completed", attempts: 1,
      usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("shares the Qwen answer contract: fenced and extra-property payloads pass unchanged", async () => {
    const fenced = "```json\n" + answer("r", "a") + "\n```";
    const fence = harness(() => completed(fenced));
    const fencedResult = await fence.call(PROMPT);
    expect(fencedResult).toMatchObject({ text: fenced, error: null, attempts: 1 });
    expect(fence.fetch).toHaveBeenCalledTimes(1);

    const extra = JSON.stringify({ reasoning: "r", answer: "a", notes: "x" });
    const extraResult = await harness(() => completed(extra)).call(PROMPT);
    expect(extraResult).toMatchObject({ text: extra, error: null, attempts: 1 });
  });

  it.each([
    ["a missing answer", JSON.stringify({ reasoning: "r" })],
    ["a non-string answer", JSON.stringify({ reasoning: "r", answer: 7 })],
    ["a blank answer", answer("r", "   ")],
    ["an array", JSON.stringify([{ reasoning: "r", answer: "a" }])],
    ["plain prose", "The answer is pottery."],
  ])("retains %s unchanged for the shared QA parser without repair or retry", async (_label, text) => {
    const { fetch, call } = harness(() => completed(text));
    const result = await call(PROMPT);
    expect(result).toMatchObject({ text, error: null, attempts: 1 });
    expect(parseAnswer(result.text)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a completed response without usable output text", async () => {
    const { call } = harness(() => json({ status: "completed", output: [{ type: "reasoning", summary: [] }] }));
    expect((await call(PROMPT)).error).toBe("response_missing_output_text");
  });

  it("does not retry a non-completed status", async () => {
    const { fetch, call } = harness(() => json({ status: "failed", output_text: answer("r", "a") }));
    expect((await call(PROMPT))).toMatchObject({ text: null, error: "response_not_completed", attempts: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries only HTTP 429/5xx, capped at six attempts, and honours Retry-After", async () => {
    const { fetch, waits, call } = harness((attempt) => attempt === 1
      ? new Response("throttled", { status: 429, headers: { "retry-after": "90" } })
      : completed(answer("r", "Glazing")));
    const result = await call(PROMPT);
    expect(result).toMatchObject({ error: null, attempts: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([60_000, 30_000]);
  });

  it("takes the longest valid retry hint and splits it into waits of at most 60s", async () => {
    const { fetch, waits, call } = harness((attempt) => attempt === 1
      ? new Response("throttled", { status: 429, headers: { "retry-after": "2", "retry-after-ms": "120000" } })
      : completed(answer("r", "Glazing")));
    const result = await call(PROMPT);
    expect(result).toMatchObject({ error: null, attempts: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([60_000, 60_000]);
  });

  it("honours x-ms-retry-after-ms when it is the longest hint", async () => {
    const { waits, call } = harness((attempt) => attempt === 1
      ? new Response("throttled", { status: 503, headers: { "retry-after": "1", "x-ms-retry-after-ms": "30000" } })
      : completed(answer("r", "a")));
    expect((await call(PROMPT)).attempts).toBe(2);
    expect(waits).toEqual([30_000]);
  });

  it("uses exponential backoff up to the cap and stops after six attempts", async () => {
    const { fetch, waits, call } = harness(() => new Response("private upstream detail", { status: 503 }));
    const result = await call(PROMPT);
    expect(result).toMatchObject({ text: null, error: "HTTP 503", attempts: 6, usage: null });
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 60_000]);
  });

  it("honours a longer HTTP-date Retry-After", async () => {
    const when = new Date(Date.now() + 15_000).toUTCString();
    const { waits, call } = harness(() => new Response("busy", { status: 500, headers: { "retry-after": when } }));
    expect((await call(PROMPT)).attempts).toBe(6);
    expect(waits.every((ms) => ms > 0 && ms <= 60_000)).toBe(true);
    expect(waits.reduce((total, ms) => total + ms, 0)).toBeGreaterThanOrEqual(6 * 15_000 - 5_000);
  });

  it("does not retry unsupported 4xx responses", async () => {
    const { fetch, waits, call } = harness(() => new Response(`{"error":"${KEY}"}`, { status: 400 }));
    const result = await call(PROMPT);
    expect(result).toMatchObject({ text: null, error: "HTTP 400", attempts: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("returns a safe failed Call when the response body cancel rejects", async () => {
    const { call } = harness(() => {
      const response = new Response(`throttled ${KEY}`, { status: 429 });
      Object.defineProperty(response, "body", {
        configurable: true,
        value: { cancel: async () => { throw new Error(`${KEY} cancel exploded`); } },
      });
      return response;
    });
    const result = await call(PROMPT);
    expect(result).toMatchObject({ text: null, error: "request_failed", attempts: 1 });
    expect(typeof result.elapsed_ms).toBe("number");
    expect(result.prompt_sha256).toBe(sha256(PROMPT));
    expect(result.request_config).toEqual({ reasoning_effort: "medium", max_output_tokens: 16_384 });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("returns a safe failed Call when the injected wait rejects", async () => {
    const { call } = harness(
      () => new Response(`busy ${KEY}`, { status: 429, headers: { "retry-after-ms": "30000" } }),
      {},
      async () => { throw new Error("clock exploded"); },
    );
    const result = await call(PROMPT);
    expect(result).toMatchObject({ text: null, error: "request_failed", attempts: 1, usage: null });
    expect(typeof result.elapsed_ms).toBe("number");
    expect(result.prompt_sha256).toBe(sha256(PROMPT));
    expect(result.request_config).toEqual({ reasoning_effort: "medium", max_output_tokens: 16_384 });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("classifies redirects and network failures without leaking them", async () => {
    const redirect = harness(async () => { throw new TypeError("Status code 302, and no location header"); });
    expect(await redirect.call(PROMPT)).toMatchObject({ error: "request_failed", attempts: 1 });
    expect(redirect.fetch).toHaveBeenCalledTimes(1);
  });

  it("reports an aborted request as a timeout", async () => {
    const { call } = harness(async () => {
      throw new DOMException("Request timed out", "TimeoutError");
    });
    expect(await call(PROMPT)).toMatchObject({ text: null, error: "timeout", attempts: 1, usage: null });
  });

  it("never returns or leaks the credential or a provider payload", async () => {
    for (const respond of [
      () => completed(answer("r", "a")),
      () => new Response(`unauthorized ${KEY}`, { status: 401 }),
      () => json({ status: "incomplete", incomplete_details: { reason: `${KEY} leaked` } }),
      async () => { throw new Error(`${KEY} in the transport message`); },
    ]) {
      const { call } = harness(respond);
      const result = await call(PROMPT);
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(Object.values(result).flat()).not.toContain(KEY);
    }
  });

  it("rejects unsupported configuration before any network use", async () => {
    const endpoints = [
      "http://recall-eval.openai.azure.com",
      "https://recall-eval.openai.azure.com:8443",
      "https://user:pass@recall-eval.openai.azure.com",
      "https://recall-eval.openai.azure.com/?api-key=secret",
      "https://recall-eval.openai.azure.com#fragment",
      "https://recall-eval.openai.azure.com/openai/v1/chat/completions",
      "https://recall-eval.openai.azure.com/deployments/gpt/responses",
      "https://evil.example.com/openai.azure.com",
      "https://notazure.com",
      "https://openai.azure.com",
      "not a url",
    ];
    for (const endpoint of endpoints) {
      const fetchImpl = vi.fn();
      expect(() => createAzureAnswerCall(config({ endpoint }), { fetch: fetchImpl })).toThrow();
      expect(fetchImpl).not.toHaveBeenCalled();
    }
    for (const overrides of [
      { key: "" }, { key: "   " }, { deployment: "" }, { deployment: "  " },
    ] satisfies Partial<AzureAnswerConfig>[]) {
      const fetchImpl = vi.fn();
      expect(() => createAzureAnswerCall(config(overrides), { fetch: fetchImpl })).toThrow();
      expect(fetchImpl).not.toHaveBeenCalled();
    }
    expect(() => createAzureAnswerCall(config({ endpoint: "https://recall-eval.openai.azure.com/" }))).not.toThrow();
  });

  it("performs no environment scanning and defaults to the long transport", async () => {
    const before = { ...process.env };
    createAzureAnswerCall(config(), { wait: async () => {} });
    expect(process.env).toEqual(before);
    expect(createAzureAnswerCall(config())).toBeTypeOf("function");
  });
});
