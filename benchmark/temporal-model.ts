import { readFileSync } from "node:fs";

export interface LocalModelAnswer {
  text: string;
  model: string;
  provider: "qwen-local";
  duration_ms: number;
  usage: { prompt_tokens: number | null; completion_tokens: number | null; total_tokens: number | null; cost_usd: null };
}

export class LocalModelError extends Error {}

export interface LocalModelDependencies {
  fetch?: typeof fetch;
  readFile?: (path: string, encoding: BufferEncoding) => string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export function validateLocalBaseUrl(raw: string | undefined): string {
  if (!raw) throw new LocalModelError("qwen-local requires DGX_BASE_URL");
  let url: URL;
  try { url = new URL(raw); } catch { throw new LocalModelError("qwen-local DGX_BASE_URL is invalid"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "::1", "[::1]", "localhost"].includes(url.hostname) || url.username || url.password || url.search || url.hash || !/\/v1\/?$/.test(url.pathname)) {
    throw new LocalModelError("qwen-local DGX_BASE_URL must be a credential-free loopback HTTP URL");
  }
  return url.toString().replace(/\/$/, "");
}

export type QwenReasoning = "none" | "low" | "medium" | "high";

export async function callQwenLocal(input: { system: string; user: string; model?: string; reasoning_effort?: QwenReasoning }, deps: LocalModelDependencies = {}): Promise<LocalModelAnswer> {
  const env = deps.env ?? process.env;
  const base = validateLocalBaseUrl(env.DGX_BASE_URL);
  const tokenPath = env.DGX_KEY_FILE;
  if (!tokenPath) throw new LocalModelError("Set DGX_KEY_FILE to the qwen-local token file");
  const token = (deps.readFile ?? readFileSync)(tokenPath, "utf8").trim();
  if (!token) throw new LocalModelError("qwen-local token is empty");
  const started = (deps.now ?? Date.now)();
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(`${base}/responses`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(45_000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: input.model ?? "qwen3.8-flash-next", input: [{ role: "system", content: input.system }, { role: "user", content: input.user }], max_output_tokens: 512, ...(input.reasoning_effort ? { reasoning: { effort: input.reasoning_effort } } : {}), temperature: 0, store: false }),
    });
  } catch (error) {
    const kind = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "request_failed";
    throw new LocalModelError(`qwen-local ${kind}`);
  }
  if (!response.ok) throw new LocalModelError(`qwen-local HTTP ${response.status}`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new LocalModelError("qwen-local malformed response"); }
  if (!isRecord(payload)) throw new LocalModelError("qwen-local malformed response");
  if (typeof payload.status === "string" && ["failed", "incomplete", "cancelled", "in_progress", "in-progress"].includes(payload.status)) {
    throw new LocalModelError("qwen-local response not completed");
  }
  if (payload.error !== undefined && payload.error !== null) throw new LocalModelError("qwen-local response error");
  const text = responseText(payload);
  if (!text.trim()) throw new LocalModelError("qwen-local malformed response");
  const usage = parseUsage(payload.usage);
  return { text: text.trim(), model: typeof payload.model === "string" ? payload.model : input.model ?? "qwen3.8-flash-next", provider: "qwen-local", duration_ms: Math.max(0, (deps.now ?? Date.now)() - started), usage };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string") {
    if (payload.output !== undefined && !Array.isArray(payload.output)) throw new LocalModelError("qwen-local malformed response");
    return payload.output_text;
  }
  if (!Array.isArray(payload.output)) throw new LocalModelError("qwen-local malformed response");
  const parts: string[] = [];
  for (const item of payload.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) throw new LocalModelError("qwen-local malformed response");
    for (const content of item.content) {
      if (isRecord(content) && content.type === "output_text" && typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("");
}

function parseUsage(value: unknown): LocalModelAnswer["usage"] {
  if (value === undefined) return { prompt_tokens: null, completion_tokens: null, total_tokens: null, cost_usd: null };
  if (!isRecord(value)) throw new LocalModelError("qwen-local malformed response");
  return {
    prompt_tokens: usageCounter(value, "input_tokens"),
    completion_tokens: usageCounter(value, "output_tokens"),
    total_tokens: usageCounter(value, "total_tokens"),
    cost_usd: null,
  };
}

function usageCounter(usage: Record<string, unknown>, field: string): number | null {
  if (usage[field] === undefined) return null;
  const value = usage[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new LocalModelError("qwen-local malformed response");
  return value;
}
