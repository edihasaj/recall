/** Offline QA evaluation. Gold answers are used only after retrieval and generation. */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as schema from "../src/db/schema.js";
import { searchMemoryFtsIndex, upsertMemoryFtsRow } from "../src/vector/sqlite-fts.js";
import { validateLocalBaseUrl } from "./temporal-model.js";
import { resolveReasoningEffort, type ReasoningEffort } from "./longmemeval-inference-policy.js";

export type Session = { id: string; date: string; text: string };
export type Case = {
  question_id: string; question_type: string; is_abstention: boolean;
  question: string; question_date: string; reference: string; gold_session_ids: string[];
  answer_prompt_prefix: string; judge_prompt_template: string; sessions: Session[];
};
export type Ranked = Session & { occurrence: number };
export type Ranking = {
  question_id: string; retrieved_session_ids: string[];
  retrieved_session_occurrences?: number[];
  source_sha256?: string;
};
export type Provider = "gemini" | "qwen-local" | "moonshot";
export type Call = {
  text: string | null; error: string | null; attempts: number; elapsed_ms: number;
  model: string; usage: Record<string, unknown> | null; prompt_sha256: string;
  request_config?: {
    reasoning_effort: Exclude<ReasoningEffort, "adaptive"> | null;
    max_output_tokens: number;
    requested_reasoning_effort?: ReasoningEffort;
  };
};
export type ModelCall = (kind: "ledger" | "answer" | "judge" | "premise" | "agree", prompt: string, meta?: { question?: string; effort?: Exclude<ReasoningEffort, "adaptive">; timeoutMs?: number }) => Promise<Call>;
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export function selectCases(cases: Case[], rankings?: Ranking[], limit?: number): Case[] {
  if (new Set(cases.map((row) => row.question_id)).size !== cases.length) throw new Error("Duplicate question IDs");
  if (rankings && new Set(rankings.map((row) => row.question_id)).size !== rankings.length) throw new Error("Duplicate ranking IDs");
  if (rankings?.some((row) => !cases.some((item) => item.question_id === row.question_id))) throw new Error("Ranking references unknown question");
  const ids = rankings ? new Set(rankings.map((row) => row.question_id)) : null;
  const selected = cases.filter((row) => !ids || ids.has(row.question_id));
  return limit ? selected.slice(0, limit) : selected;
}

/** The production FTS implementation, in a disposable index with no live memory store. */
export function lexicalRank(question: string, sessions: Session[], topK: number): Ranked[] {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  try {
    sqlite.transaction(() => {
      sessions.forEach((session, occurrence) => upsertMemoryFtsRow(db, {
        id: String(occurrence), text: session.text, note: null, repo: "isolated-question",
        status: "active", type: "rule", scope: "repo", path_scope: null, confidence: .9,
      }));
    })();
    return searchMemoryFtsIndex(db, question, { repo: "isolated-question", mode: "or", limit: topK })
      .map(({ memory_id }) => ({ ...sessions[Number(memory_id)]!, occurrence: Number(memory_id) }));
  } finally { sqlite.close(); }
}

/** A repeated source ID expands to all its original occurrences, in source order. */
export function cachedRank(sessions: Session[], ids: string[], topK: number, occurrences?: number[]): Ranked[] {
  if (occurrences !== undefined) {
    if (occurrences.length !== ids.length) throw new Error("Ranking occurrence count mismatch");
    const seen = new Set<number>();
    return ids.map((id, index) => {
      const occurrence = occurrences[index]!;
      if (!Number.isInteger(occurrence) || occurrence < 0 || occurrence >= sessions.length) {
        throw new Error("Ranking occurrence out of bounds");
      }
      if (sessions[occurrence]!.id !== id) throw new Error("Ranking occurrence source mismatch");
      if (seen.has(occurrence)) throw new Error("Duplicate ranking occurrence");
      seen.add(occurrence);
      return { ...sessions[occurrence]!, occurrence };
    }).slice(0, topK);
  }
  const used = new Set<number>(), rows: Ranked[] = [];
  for (const id of ids) {
    const matches = sessions.flatMap((session, occurrence) => session.id === id ? [{ ...session, occurrence }] : []);
    if (!matches.length) throw new Error("Cached ranking references missing session");
    for (const row of matches) if (!used.has(row.occurrence)) { rows.push(row); used.add(row.occurrence); }
  }
  return rows.slice(0, topK);
}

/** Redistributes unused quota, preserving every source label and a prefix of each source. */
export function buildEvidence(rows: Ranked[], cap: number) {
  // Corpus IDs encode the gold label ("answer_..."). Neither those IDs nor
  // original haystack positions belong in the answering model's context.
  const labels = rows.map((row, index) => `## Memory ${index + 1}\nConversation date: ${row.date}.\n`);
  const overhead = labels.reduce((n, label) => n + label.length, 0) + Math.max(0, rows.length - 1) * 2;
  if (overhead > cap) throw new Error("Source labels exceed context cap");
  let room = cap - overhead;
  const allocation = rows.map(() => 0);
  let pending = rows.map((_, i) => i);
  while (pending.length && room > 0) {
    const quota = Math.max(1, Math.floor(room / pending.length));
    for (const i of pending) {
      const add = Math.min(room, quota, rows[i]!.text.length - allocation[i]!);
      allocation[i]! += add; room -= add;
    }
    pending = pending.filter((i) => allocation[i]! < rows[i]!.text.length);
  }
  const text = rows.map((row, i) => labels[i]! + row.text.slice(0, allocation[i])).join("\n\n");
  return {
    text, chars: text.length, full_chars: overhead + rows.reduce((n, row) => n + row.text.length, 0),
    sources: rows.map((row, i) => ({ id: row.id, occurrence: row.occurrence, date: row.date, full_chars: row.text.length, used_chars: allocation[i]!, truncated: allocation[i]! < row.text.length })),
  };
}

export function answerPrompt(item: Pick<Case, "answer_prompt_prefix">, context: string): string {
  const marker = "__RECALL_CONTEXT__";
  if (item.answer_prompt_prefix.split(marker).length !== 2) throw new Error("Invalid answer prompt marker");
  return item.answer_prompt_prefix.replace(marker, () => context);
}
export function judgePrompt(item: Pick<Case, "judge_prompt_template">, candidate: string): string {
  const marker = "__RECALL_CANDIDATE__";
  if (item.judge_prompt_template.split(marker).length !== 2) throw new Error("Invalid judge prompt marker");
  return item.judge_prompt_template.replace(marker, () => candidate);
}
export function parseObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
export const parseAnswer = (text: string | null): string | null => {
  const value = parseObject(text);
  return typeof value?.answer === "string" && value.answer.trim() ? value.answer : null;
};
export const parseJudge = (text: string | null): boolean | null => {
  const value = parseObject(text);
  return typeof value?.correct === "boolean" ? value.correct : null;
};
export function safeError(error: unknown): string {
  if (error instanceof Error && /^HTTP \d{3}$/.test(error.message)) return error.message;
  return error instanceof Error && /timeout|abort/i.test(error.name) ? "timeout" : "request_failed";
}

export function createModelCall(
  provider: Provider,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
  options?: { structuredOutput?: boolean; reasoningEffort?: ReasoningEffort; maxOutputTokens?: number; answerInstructions?: string; ledgerFormat?: "quoted" | "units" | "packed" },
): ModelCall {
  if (options?.reasoningEffort === "adaptive" && provider !== "qwen-local") throw new Error("Adaptive reasoning requires qwen-local");
  if (
    options?.reasoningEffort === "adaptive"
    && (
      typeof options.maxOutputTokens !== "number"
      || !Number.isInteger(options.maxOutputTokens)
      || options.maxOutputTokens < 1
    )
  ) throw new Error("Adaptive reasoning requires a positive integer --max-output-tokens");
  const base = provider === "qwen-local" ? validateLocalBaseUrl(process.env.DGX_BASE_URL) : null;
  const token = provider === "qwen-local"
    ? (process.env.DGX_KEY_FILE ? readFileSync(process.env.DGX_KEY_FILE, "utf8").trim() : "")
    : provider === "moonshot" ? process.env.MOONSHOT_API_KEY : process.env.GEMINI_API_KEY;
  if (!token) throw new Error("Missing model credential");
  return async (kind, prompt, meta) => {
    const model = provider === "gemini" ? kind === "answer" ? "gemini-3.1-pro-preview" : "gemini-2.5-flash-lite" : provider === "moonshot" ? "kimi-k2.7-code-highspeed" : "qwen3.8-flash-next";
    const started = Date.now();
    let attempts = 0, error: string | null = null;
    const outputTokens = kind === "ledger" ? 8192 : kind === "answer" ? options?.maxOutputTokens ?? 4096 : 4096;
    const requestedEffort: ReasoningEffort = kind === "ledger" || kind === "premise" ? "low" : kind === "answer" ? options?.reasoningEffort ?? "none" : "none";
    let effectiveEffort: Exclude<ReasoningEffort, "adaptive">;
    if (provider === "qwen-local" && kind === "answer" && meta?.effort) {
      effectiveEffort = meta.effort;
    } else if (provider === "qwen-local" && kind === "answer" && requestedEffort === "adaptive") {
      if (typeof meta?.question !== "string" || !meta.question.trim()) {
        error = "adaptive_question_missing";
        return {
          text: null, error, model, usage: null, attempts, elapsed_ms: Date.now() - started,
          prompt_sha256: sha256(prompt),
          request_config: { reasoning_effort: null, max_output_tokens: outputTokens, requested_reasoning_effort: "adaptive" },
        };
      }
      effectiveEffort = resolveReasoningEffort(requestedEffort, meta.question);
    } else {
      effectiveEffort = requestedEffort as Exclude<ReasoningEffort, "adaptive">;
    }
    const requestConfig = provider === "qwen-local"
      ? { reasoning_effort: effectiveEffort, max_output_tokens: outputTokens }
      : undefined;
    const result = (text: string | null, actualModel = model, usage: Record<string, unknown> | null = null): Call =>
      ({ text, error, model: actualModel, usage, attempts, elapsed_ms: Date.now() - started, prompt_sha256: sha256(prompt), ...(requestConfig ? { request_config: requestConfig } : {}) });
    for (;;) {
      attempts++;
      try {
        const selectionIndex = kind === "ledger" && (options?.ledgerFormat === "units" || options?.ledgerFormat === "packed");
        const packedIndex = kind === "ledger" && options?.ledgerFormat === "packed";
        const properties = selectionIndex
          ? { selections: { type: "ARRAY" } }
          : kind === "ledger"
          ? { facts: { type: "ARRAY" } }
          : kind === "answer" ? { reasoning: { type: "STRING" }, answer: { type: "STRING" } } : { correct: { type: "BOOLEAN" }, reason: { type: "STRING" } };
        const schema = { type: "OBJECT", properties, required: Object.keys(properties) };
        const system = selectionIndex
          ? "Return only JSON with a selections array."
          : kind === "ledger"
          ? "Return only JSON with a facts array."
          : kind === "judge" || kind === "premise" || kind === "agree" ? "Return only JSON with correct:boolean and reason:string fields." : "Return only JSON with reasoning and answer string fields.";
        const strictFormat = provider === "qwen-local" && options?.structuredOutput
          ? {
            type: "json_schema",
            name: packedIndex ? "benchmark_evidence_packed_index" : selectionIndex ? "benchmark_evidence_unit_index" : kind === "ledger" ? "benchmark_evidence_ledger" : kind === "answer" ? "benchmark_answer" : kind === "premise" ? "benchmark_premise" : kind === "agree" ? "benchmark_agreement" : "benchmark_judge",
            strict: true,
            schema: {
              type: "object",
              properties: selectionIndex
                ? {
                  selections: {
                    type: "array", maxItems: 24,
                    items: {
                      type: "object",
                      properties: { source_rank: { type: "integer" }, unit_index: { type: "integer" } },
                      required: ["source_rank", "unit_index"],
                      additionalProperties: false,
                    },
                  },
                }
                : kind === "ledger"
                ? {
                  facts: {
                    type: "array", maxItems: 24,
                    items: {
                      type: "object",
                      properties: {
                        source_rank: { type: "integer" }, unit_index: { type: "integer" },
                        entity: { type: "string", maxLength: 160 }, relation: { type: "string", maxLength: 160 },
                        status: { type: "string", maxLength: 160 }, event_time: { type: ["string", "null"], maxLength: 160 },
                      },
                      required: ["source_rank", "unit_index", "entity", "relation", "status", "event_time"],
                      additionalProperties: false,
                    },
                  },
                }
                : kind === "answer"
                ? { reasoning: { type: "string" }, answer: { type: "string" } }
                : { correct: { type: "boolean" }, reason: { type: "string" } },
              required: selectionIndex ? ["selections"] : kind === "ledger" ? ["facts"] : kind === "answer" ? ["reasoning", "answer"] : ["correct", "reason"],
              additionalProperties: false,
            },
          }
          : undefined;
        const body = provider === "gemini"
          ? { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: schema } }
          : provider === "moonshot"
            ? { model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], max_tokens: 8192, response_format: { type: "json_object" }, thinking: { type: "enabled" } }
            : {
              model,
              input: [{
                role: "system",
                content: (strictFormat ? system : kind === "ledger" ? system : "Return only JSON with reasoning and answer string fields." + (kind === "judge" || kind === "premise" || kind === "agree" ? " For evaluation return correct:boolean and reason:string instead." : ""))
                  + (kind === "answer" && options?.answerInstructions ? `\n\n${options.answerInstructions}` : ""),
              }, { role: "user", content: prompt }],
              temperature: 0, reasoning: { effort: effectiveEffort },
              max_output_tokens: outputTokens, store: false,
              ...(strictFormat ? { text: { format: strictFormat } } : {}),
            };
        const endpoint = provider === "gemini" ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` : provider === "moonshot" ? "https://api.moonshot.ai/v1/chat/completions" : `${base}/responses`;
        const response = await fetcher(endpoint, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(meta?.timeoutMs ?? (provider === "qwen-local" ? 600_000 : 180_000)),
          headers: provider === "gemini" ? { "Content-Type": "application/json", "x-goog-api-key": token } : { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempts < 6) {
            await response.body?.cancel();
            const rawRetryAfter = response.headers.get("retry-after");
            const numericRetryAfter = rawRetryAfter === null ? NaN : Number(rawRetryAfter);
            const retryAfter = Number.isFinite(numericRetryAfter) ? numericRetryAfter
              : rawRetryAfter ? (Date.parse(rawRetryAfter) - Date.now()) / 1000 : 0;
            const backoff = Math.max(Math.min(60, 5 * 2 ** (attempts - 1)), Number.isFinite(retryAfter) ? Math.max(0, retryAfter) : 0);
            for (let remaining = backoff; remaining > 0; remaining -= 60) {
              await new Promise((resolve) => setTimeout(resolve, Math.min(60, remaining) * 1000));
            }
            continue;
          }
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = await response.json() as Record<string, any>;
        if (provider === "gemini") {
          const candidate = payload.candidates?.[0];
          if (candidate?.finishReason !== "STOP") { error = "response_not_completed"; return result(null); }
          return result(candidate.content?.parts?.filter((p: any) => !p.thought).map((p: any) => p.text ?? "").join("") || null, payload.modelVersion ?? model, payload.usageMetadata ?? null);
        }
        if (provider === "moonshot") {
          const choice = payload.choices?.[0];
          if (choice?.finish_reason !== "stop") { error = "response_not_completed"; return result(null, payload.model ?? model, payload.usage ?? null); }
          return result(typeof choice.message?.content === "string" ? choice.message.content : null, payload.model ?? model, payload.usage ?? null);
        }
        if (payload.status !== "completed" || payload.error) { error = "response_not_completed"; return result(null, payload.model ?? model, payload.usage ?? null); }
        const text = payload.output_text ?? payload.output?.flatMap((item: any) => item.content ?? []).filter((item: any) => item.type === "output_text").map((item: any) => item.text).join("");
        return result(typeof text === "string" ? text : null, payload.model ?? model, payload.usage ?? null);
      } catch (caught) { error = safeError(caught); return result(null); }
    }
  };
}
