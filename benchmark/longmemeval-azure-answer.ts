/**
 * Azure Responses answer adapter for the LongMemEval answer-model trial.
 *
 * Configuration is explicit: endpoint, deployment, key and answer instructions
 * are supplied by the caller. This module performs no credential discovery and
 * never echoes a credential or a raw provider payload back through `Call`.
 */
import { safeError, sha256, type Call } from "./longmemeval-qa-support.js";
import { longRequestFetch } from "./longmemeval-qa-transport.js";

export const AZURE_ANSWER_SYSTEM = "Return only JSON with reasoning and answer string fields.";
export const AZURE_REASONING_EFFORT = "medium";
export const AZURE_MAX_OUTPUT_TOKENS = 16_384;
const RESPONSES_PATH = "/openai/v1/responses";
const HOST_SUFFIXES = [".cognitiveservices.azure.com", ".openai.azure.com"] as const;
const MAX_ATTEMPTS = 6;
const TIMEOUT_MS = 600_000;
const BASE_BACKOFF_SECONDS = 5;
const MAX_BACKOFF_SECONDS = 60;
const MAX_SLEEP_MS = 60_000;

export type AzureAnswerConfig = {
  endpoint: string;
  deployment: string;
  key: string;
  answerInstructions: string;
};

export type AzureFetcher = (url: string, init: RequestInit) => Promise<Response>;
export type AzureAnswerDeps = {
  fetch?: AzureFetcher;
  /** Injectable sleep so tests never wait on real clocks. */
  wait?: (ms: number) => Promise<void>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Exact public Azure resource root, or the exact Responses path under it. */
export function azureResponsesUrl(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Azure endpoint must be an absolute HTTPS URL");
  }
  if (url.protocol !== "https:") throw new Error("Azure endpoint must use HTTPS");
  if (url.username || url.password) throw new Error("Azure endpoint must not carry credentials");
  if (url.search) throw new Error("Azure endpoint must not carry a query");
  if (url.hash) throw new Error("Azure endpoint must not carry a fragment");
  if (url.port) throw new Error("Azure endpoint must use the default HTTPS port");
  const host = url.hostname.toLowerCase();
  const suffix = HOST_SUFFIXES.find((candidate) => host.endsWith(candidate) && host.slice(0, -candidate.length).length > 0);
  if (!suffix) throw new Error("Azure endpoint host is not a supported Azure OpenAI endpoint");
  const path = url.pathname === "/" ? "" : url.pathname;
  if (path !== "" && path !== RESPONSES_PATH) throw new Error("Azure endpoint path is not the Responses endpoint");
  return `${url.origin}${RESPONSES_PATH}`;
}

/** `output_text`, otherwise the `output_text` parts of response messages. */
function responseText(payload: Record<string, unknown>): string | null {
  if (typeof payload.output_text === "string") return payload.output_text;
  const items = Array.isArray(payload.output) ? payload.output : [];
  const chunks: string[] = [];
  for (const item of items) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") chunks.push(part.text);
    }
  }
  return chunks.length ? chunks.join("") : null;
}

/** Longest valid retry hint across the supported Retry-After headers, in seconds. */
function retryHintSeconds(response: Response): number {
  let best = 0;
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const numeric = Number(retryAfter);
    if (Number.isFinite(numeric)) best = Math.max(best, Math.max(0, numeric));
    else {
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) best = Math.max(best, Math.max(0, (date - Date.now()) / 1000));
    }
  }
  for (const name of ["retry-after-ms", "x-ms-retry-after-ms"]) {
    const raw = response.headers.get(name);
    if (raw === null) continue;
    const ms = Number(raw);
    if (Number.isFinite(ms) && ms >= 0) best = Math.max(best, ms / 1000);
  }
  return best;
}

/** Cancel a response body without ever letting a cancel failure throw or leak. */
async function cancelResponseBody(response: Response): Promise<string | null> {
  try {
    await response.body?.cancel();
    return null;
  } catch (caught) {
    return safeError(caught);
  }
}

export function createAzureAnswerCall(
  config: AzureAnswerConfig,
  deps: AzureAnswerDeps = {},
): (prompt: string) => Promise<Call> {
  const url = azureResponsesUrl(config.endpoint);
  const deployment = config.deployment.trim();
  const key = config.key.trim();
  if (!deployment) throw new Error("Azure deployment is required");
  if (!key) throw new Error("Azure key is required");
  if (typeof config.answerInstructions !== "string") throw new Error("Azure answer instructions must be a string");
  // Preserved byte for byte: fixed prefix + "\n\n" + the explicit config string, no trim.
  const system = `${AZURE_ANSWER_SYSTEM}\n\n${config.answerInstructions}`;
  const fetcher: AzureFetcher = deps.fetch ?? longRequestFetch;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));

  return async (prompt: string): Promise<Call> => {
    const started = Date.now();
    const requestConfig: NonNullable<Call["request_config"]> =
      { reasoning_effort: AZURE_REASONING_EFFORT, max_output_tokens: AZURE_MAX_OUTPUT_TOKENS };
    const done = (text: string | null, error: string | null): Call => ({
      text, error, model: deployment, usage: null, attempts,
      elapsed_ms: Date.now() - started, prompt_sha256: sha256(prompt), request_config: requestConfig,
    });
    const body = JSON.stringify({
      model: deployment,
      input: [{ role: "system", content: system }, { role: "user", content: prompt }],
      reasoning: { effort: AZURE_REASONING_EFFORT },
      max_output_tokens: AZURE_MAX_OUTPUT_TOKENS,
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "benchmark_answer",
          strict: true,
          schema: {
            type: "object",
            properties: { reasoning: { type: "string" }, answer: { type: "string" } },
            required: ["reasoning", "answer"],
            additionalProperties: false,
          },
        },
      },
    });
    let attempts = 0;
    for (;;) {
      attempts++;
      let response: Response;
      try {
        response = await fetcher(url, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { "Content-Type": "application/json", "api-key": key },
          body,
        });
      } catch (caught) {
        return done(null, safeError(caught));
      }
      if (!response.ok) {
        const status = response.status;
        const retryable = (status === 429 || status >= 500) && attempts < MAX_ATTEMPTS;
        const cancelError = await cancelResponseBody(response);
        if (cancelError) return done(null, cancelError);
        if (retryable) {
          const backoff = Math.max(
            Math.min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * 2 ** (attempts - 1)),
            retryHintSeconds(response),
          );
          try {
            for (let remaining = backoff * 1000; remaining > 0; remaining -= MAX_SLEEP_MS) {
              await wait(Math.min(MAX_SLEEP_MS, remaining));
            }
          } catch (caught) {
            return done(null, safeError(caught));
          }
          continue;
        }
        return done(null, `HTTP ${status}`);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (caught) {
        return done(null, safeError(caught));
      }
      const record = isRecord(payload) ? payload : {};
      const model = typeof record.model === "string" && record.model ? record.model : deployment;
      const usage = isRecord(record.usage) ? record.usage : null;
      const finished = (text: string | null, error: string | null): Call => ({
        text, error, model, usage, attempts,
        elapsed_ms: Date.now() - started, prompt_sha256: sha256(prompt), request_config: requestConfig,
      });
      if (record.error) return finished(null, "response_not_completed");
      if (record.status === "incomplete") return finished(null, "response_incomplete");
      if (record.status !== "completed") return finished(null, "response_not_completed");
      const text = responseText(record);
      if (text === null) return finished(null, "response_missing_output_text");
      // Keep every completed output, including malformed JSON, for the shared
      // QA parser and immutable error accounting used by the Qwen control.
      return finished(text, null);
    }
  };
}
