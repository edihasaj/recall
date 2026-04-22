import { randomUUID } from "node:crypto";
import { getApiKey, type LlmProvider } from "../credentials/keychain.js";
import type { RecallDb } from "../db/client.js";
import { llmUsage } from "../db/schema.js";

export type { LlmProvider };

export interface LlmCallInput {
  provider: LlmProvider;
  model?: string;
  system: string;
  user: string;
  max_output_tokens?: number;
  temperature?: number;
  task_kind: string;
  task_id?: string | null;
  repo?: string | null;
}

export interface LlmUsageRow {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
}

export interface LlmCallResult {
  text: string;
  usage: LlmUsageRow;
  model: string;
  provider: LlmProvider;
  duration_ms: number;
}

export class LlmCredentialError extends Error {}
export class LlmRequestError extends Error {}

export const DEFAULT_MODELS: Record<LlmProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
};

// Rough per-1M token rates ($). Kept conservative; tighten when model pricing shifts.
// Map by exact model id; unknown models fall through to null cost (still tracked, just un-priced).
const COST_PER_M_TOKENS: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-opus-4-7": { input: 15.0, output: 75.0 },
};

export async function callLlm(
  db: RecallDb,
  input: LlmCallInput,
): Promise<LlmCallResult> {
  const provider = input.provider;
  const model = input.model ?? DEFAULT_MODELS[provider];
  const apiKey = getApiKey(provider);
  if (!apiKey) {
    throw new LlmCredentialError(
      `No API key for provider "${provider}". Set it via \`recall maintenance credentials --set ${provider}\` or the ${provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} env var.`,
    );
  }

  const started = Date.now();
  let result: LlmCallResult | null = null;
  let errorMessage: string | undefined;

  try {
    result = provider === "openai"
      ? await callOpenAi(apiKey, model, input)
      : await callAnthropic(apiKey, model, input);
    return result;
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    try {
      await recordUsage(db, {
        provider,
        model,
        task_kind: input.task_kind,
        task_id: input.task_id ?? null,
        repo: input.repo ?? null,
        usage: result?.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: null },
        duration_ms: Date.now() - started,
        ok: Boolean(result),
        error: errorMessage,
      });
    } catch {
      // telemetry must never break the caller
    }
  }
}

async function callOpenAi(
  apiKey: string,
  model: string,
  input: LlmCallInput,
): Promise<LlmCallResult> {
  const started = Date.now();
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
      max_tokens: input.max_output_tokens ?? 2048,
      temperature: input.temperature ?? 0,
    }),
  });

  if (!response.ok) {
    const body = await safeText(response);
    throw new LlmRequestError(`OpenAI ${response.status}: ${body.slice(0, 400)}`);
  }

  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const text = payload.choices?.[0]?.message?.content?.trim() ?? "";
  const prompt_tokens = payload.usage?.prompt_tokens ?? 0;
  const completion_tokens = payload.usage?.completion_tokens ?? 0;
  const total_tokens = payload.usage?.total_tokens ?? prompt_tokens + completion_tokens;

  return {
    text,
    model,
    provider: "openai",
    duration_ms: Date.now() - started,
    usage: {
      prompt_tokens,
      completion_tokens,
      total_tokens,
      cost_usd: computeCost(model, prompt_tokens, completion_tokens),
    },
  };
}

async function callAnthropic(
  apiKey: string,
  model: string,
  input: LlmCallInput,
): Promise<LlmCallResult> {
  const started = Date.now();
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      system: input.system,
      messages: [{ role: "user", content: input.user }],
      max_tokens: input.max_output_tokens ?? 2048,
      temperature: input.temperature ?? 0,
    }),
  });

  if (!response.ok) {
    const body = await safeText(response);
    throw new LlmRequestError(`Anthropic ${response.status}: ${body.slice(0, 400)}`);
  }

  const payload = await response.json() as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (payload.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
  const prompt_tokens = payload.usage?.input_tokens ?? 0;
  const completion_tokens = payload.usage?.output_tokens ?? 0;

  return {
    text,
    model,
    provider: "anthropic",
    duration_ms: Date.now() - started,
    usage: {
      prompt_tokens,
      completion_tokens,
      total_tokens: prompt_tokens + completion_tokens,
      cost_usd: computeCost(model, prompt_tokens, completion_tokens),
    },
  };
}

function computeCost(model: string, inputTokens: number, outputTokens: number): number | null {
  const rates = COST_PER_M_TOKENS[model];
  if (!rates) return null;
  return (
    (inputTokens / 1_000_000) * rates.input +
    (outputTokens / 1_000_000) * rates.output
  );
}

async function recordUsage(
  db: RecallDb,
  row: {
    provider: LlmProvider;
    model: string;
    task_kind: string;
    task_id: string | null;
    repo: string | null;
    usage: LlmUsageRow;
    duration_ms: number;
    ok: boolean;
    error?: string;
  },
): Promise<void> {
  await db.insert(llmUsage).values({
    id: randomUUID(),
    provider: row.provider,
    model: row.model,
    task_kind: row.task_kind,
    task_id: row.task_id,
    repo: row.repo,
    prompt_tokens: row.usage.prompt_tokens,
    completion_tokens: row.usage.completion_tokens,
    total_tokens: row.usage.total_tokens,
    cost_usd: row.usage.cost_usd ?? null,
    duration_ms: row.duration_ms,
    ok: row.ok,
    error: row.error ?? null,
    created_at: new Date().toISOString(),
  });
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
