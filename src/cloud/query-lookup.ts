import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { redactSensitiveText } from "../security/redaction.js";
import type { CloudQueryConnection } from "./query-settings.js";

const REQUEST_TIMEOUT_MS = 3_000;
const FAILURE_COOLDOWN_MS = 15_000;
const CACHE_TTL_MS = 60_000;
const MAX_ENTRIES = 8;
const MAX_RESPONSE_BYTES = 256 * 1024;
export type CloudResult = { status: "ok" | "timeout" | "unavailable"; payload?: unknown };
interface Entry { namespace: string; queryKey: string; expires: number; payload: unknown }
interface Flight { key: string; controller: AbortController; promise: Promise<CloudResult> }
const cache = new Map<string, Entry>();
const failures = new Map<string, number>();
let flight: Flight | undefined;
let generation = 0;
let backgroundEnabled = true;

/** One-shot CLI processes cannot deliver a later response after exiting. */
export function setCloudQueryBackgroundEnabled(enabled: boolean): void { backgroundEnabled = enabled; }
export function cloudQueryBackgroundEnabled(): boolean { return backgroundEnabled; }

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

async function readBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("Cloud response exceeds limit");
  }
  if (!response.body) throw new Error("Cloud response is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("Cloud request aborted"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Cloud response exceeds limit");
      chunks.push(value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(body));
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/** A process-local cache only: no question text, token, or result is written to disk. */
export function startCloudLookup(connection: CloudQueryConnection, dbPath: string, repo: string, query: string): {
  cached: Array<{ payload: unknown; sameQuery: boolean }>;
  promise?: Promise<CloudResult>;
  cancel?: () => void;
  status: "ok" | "pending" | "busy" | "unavailable";
} {
  const question = redactSensitiveText(query);
  const namespace = digest(JSON.stringify([connection.api, connection.token, connection.consentVersion, realpathSync(dbPath), repo]));
  const queryKey = digest(question);
  const key = `${namespace}:${queryKey}`;
  const now = Date.now();
  for (const [id, entry] of cache) if (entry.expires <= now) cache.delete(id);
  for (const [id, expires] of failures) if (expires <= now) failures.delete(id);
  const cached = [...cache.values()].filter((entry) => entry.namespace === namespace)
    .reverse().sort((a, b) => Number(b.queryKey === queryKey) - Number(a.queryKey === queryKey))
    .map((entry) => ({ payload: entry.payload, sameQuery: entry.queryKey === queryKey }));
  if (cache.has(key)) return { cached, status: "ok" };
  if (flight) return flight.key === key
    ? { cached, status: "pending", promise: flight.promise }
    : { cached, status: "busy" };
  if (failures.has(namespace)) return { cached, status: "unavailable" };

  const controller = new AbortController();
  const epoch = generation;
  // The request continues after a caller's 150ms grace window. Only the actual
  // network/body deadline or an error counts as a Cloud failure.
  let deadline: NodeJS.Timeout | undefined;
  const expired = new Promise<CloudResult>((resolve) => {
    deadline = setTimeout(() => { controller.abort(); resolve({ status: "timeout" }); }, REQUEST_TIMEOUT_MS);
    deadline.unref?.();
  });
  const request = (async (): Promise<CloudResult> => {
    try {
      const response = await fetch(`${connection.api}/v1/compile`, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${connection.token}` },
        body: JSON.stringify({ query: question, retrievalMode: "auto", status: "active", limit: 12,
          contextChars: 1_000, perSourceChars: 256, supplementalSources: 0,
          semanticSupplementalSources: 0, relevance: false, clientEnrichment: true }),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        return { status: "unavailable" };
      }
      return { status: "ok", payload: await readBody(response, controller.signal) };
    } catch { return { status: controller.signal.aborted ? "timeout" : "unavailable" }; }
  })();
  const current: Flight = { key, controller, promise: Promise.resolve({ status: "unavailable" }) };
  current.promise = Promise.race([request, expired]).then((result) => {
    if (epoch !== generation) return { status: "unavailable" } as CloudResult;
    if (result.status === "ok") {
      cache.set(key, { namespace, queryKey, expires: Date.now() + CACHE_TTL_MS, payload: result.payload });
      while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
      failures.delete(namespace);
    } else {
      failures.set(namespace, Date.now() + FAILURE_COOLDOWN_MS);
      while (failures.size > 64) failures.delete(failures.keys().next().value!);
    }
    return result;
  }).finally(() => {
    if (deadline) clearTimeout(deadline);
    if (flight === current) flight = undefined;
  });
  flight = current;
  return { cached, status: "pending", promise: current.promise, cancel: () => controller.abort() };
}

export function resetCloudLookupsForTests(): void {
  generation += 1;
  backgroundEnabled = true;
  flight?.controller.abort();
  flight = undefined;
  cache.clear();
  failures.clear();
}
