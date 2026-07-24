/**
 * Hypothetical Document Embeddings (HyDE) for natural-language queries.
 *
 * When the user types a chat-style question like "What degree did I graduate
 * with?" the embedding of the *question* lives in question-space and rarely
 * lands near the embedding of the *answer chunk*. HyDE bridges this by asking
 * a small LLM for a one-sentence plausible answer first, then embedding that
 * answer instead. Original paper: arxiv.org/abs/2212.10496.
 *
 * Gated behind RECALL_HYDE (default off). Caches by SHA256(provider+model+query)
 * to a disk JSON when RECALL_HYDE_CACHE_PATH is set — makes benchmarks
 * reproducible without repeated LLM spend.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RecallDb } from "../db/client.js";
import { callLlm, type LlmProvider } from "../llm/client.js";
import { hasProviderConfigured } from "../credentials/keychain.js";
import {
  atomicWriteUtf8File,
  readUtf8FileIfExists,
} from "../security/atomic-file.js";

const HYDE_SYSTEM_PROMPT =
  "Generate a single short sentence that plausibly answers the user's question. " +
  "Do not include preamble, qualifications, or follow-up questions. " +
  "If the question is unanswerable without specific personal context, " +
  "produce a sentence in the format of a likely answer using neutral placeholders. " +
  "Output only the sentence.";

const MEMORY_CACHE_MAX = 512;
const memoryCache = new Map<string, string>();
let diskCacheLoaded = false;
let diskCache: Record<string, string> = {};

function resolveProvider(): LlmProvider | null {
  const order: LlmProvider[] = ["anthropic", "azure-openai", "openai"];
  for (const p of order) if (hasProviderConfigured(p)) return p;
  return null;
}

function defaultModel(provider: LlmProvider): string {
  if (provider === "anthropic") return "claude-haiku-4-5-20251001";
  if (provider === "openai") return "gpt-4o-mini";
  return ""; // azure-openai uses deployment from config
}

function hashKey(provider: string, model: string, query: string): string {
  return createHash("sha256")
    .update(`${provider}::${model}::${query}`)
    .digest("hex");
}

function loadDiskCache(): void {
  if (diskCacheLoaded) return;
  diskCacheLoaded = true;
  const path = process.env.RECALL_HYDE_CACHE_PATH;
  if (!path) return;
  try {
    const raw = readUtf8FileIfExists(path);
    if (raw === null) return;
    diskCache = JSON.parse(raw);
  } catch {
    diskCache = {};
  }
}

function persistDiskCache(): void {
  const path = process.env.RECALL_HYDE_CACHE_PATH;
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteUtf8File(path, JSON.stringify(diskCache, null, 2));
  } catch {
    // cache is a perf optimization; never let IO break retrieval
  }
}

/**
 * Heuristic: this is a natural-language question worth running HyDE on.
 * - Ends in `?`
 * - Has at least 3 words
 * - Doesn't look like a code/path/identifier query (no slashes, no `::`,
 *   no extension dots like `.ts`/`.py`).
 */
export function isHydeCandidate(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed.endsWith("?")) return false;
  if (trimmed.split(/\s+/).length < 3) return false;
  if (/[\\/]|::|\.[a-z]{1,4}\b/.test(trimmed)) return false;
  return true;
}

/**
 * Returns a hypothetical-answer sentence for `query` or null if HyDE is
 * disabled / no provider / the query doesn't look like a chat question.
 * Never throws — falls through to null on any error so callers can degrade
 * to plain query embedding.
 */
export async function generateHydeText(
  db: RecallDb,
  query: string,
): Promise<string | null> {
  if (process.env.RECALL_HYDE !== "true") return null;
  if (!isHydeCandidate(query)) return null;

  const provider = resolveProvider();
  if (!provider) return null;
  const model =
    process.env.RECALL_HYDE_MODEL ?? defaultModel(provider);
  const key = hashKey(provider, model, query);

  if (memoryCache.has(key)) return memoryCache.get(key) ?? null;
  loadDiskCache();
  if (diskCache[key]) {
    if (memoryCache.size > MEMORY_CACHE_MAX) memoryCache.clear();
    memoryCache.set(key, diskCache[key]);
    return diskCache[key];
  }

  try {
    const result = await callLlm(db, {
      provider,
      model: model || undefined,
      system: HYDE_SYSTEM_PROMPT,
      user: query,
      max_output_tokens: 96,
      temperature: 0,
      task_kind: "hyde",
    });
    const text = result.text.trim();
    if (text.length === 0) return null;
    if (memoryCache.size > MEMORY_CACHE_MAX) memoryCache.clear();
    memoryCache.set(key, text);
    diskCache[key] = text;
    persistDiskCache();
    return text;
  } catch {
    return null;
  }
}

// Test helper: clear in-memory cache (disk cache untouched).
export function resetHydeMemoryCache(): void {
  memoryCache.clear();
  diskCacheLoaded = false;
  diskCache = {};
}
