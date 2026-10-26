import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

const require = createRequire(import.meta.url);
const MAX_CANDIDATES = 12;
let betterSqlite3Path: string | undefined;
let workerInFlight = false;

interface WorkerHandle {
  once(event: "message" | "error" | "exit", listener: (...args: unknown[]) => void): unknown;
  terminate(): Promise<number>;
  unref?(): void;
}

type WorkerFactory = (source: string, options: ConstructorParameters<typeof Worker>[1]) => WorkerHandle;
let workerFactory: WorkerFactory = (source, options) => new Worker(source, options);

export interface QueryDedupeResult {
  matchedHashes: Set<string>;
  repoAliases: Set<string>;
}

export function normalizedTextHash(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}

function makeWorkerSource(modulePath: string): string {
  return `
const { parentPort, workerData } = require("node:worker_threads");
const { createHash } = require("node:crypto");
const Database = require(${JSON.stringify(modulePath)});
const normalizeHash = (text) => createHash("sha256")
  .update(String(text).replace(/\\r\\n?/g, "\\n").trim().replace(/\\s+/g, " "))
  .digest("hex");
let db;
let outcome = { error: true };
try {
  db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true, timeout: 10 });
  db.pragma("query_only = ON");
  db.pragma("busy_timeout = 10");
  const wanted = new Set(workerData.candidateHashes);
  const matched = [];
  const basename = workerData.repo.split("/").at(-1);
  const qualified = new Set();
  const rows = db.prepare("SELECT text, repo FROM memories");
  let timedOut = false;
  for (const row of rows.iterate()) {
    if (Date.now() >= workerData.deadlineAt) {
      timedOut = true;
      break;
    }
    const repo = row.repo;
    if (qualified.size < 2 && basename && typeof repo === "string" && repo.includes("/") && repo.split("/").at(-1) === basename) {
      qualified.add(repo);
    }
    const hash = normalizeHash(row.text);
    if (wanted.has(hash) && !matched.includes(hash)) {
      matched.push(hash);
      if (matched.length === wanted.size) break;
    }
  }
  if (timedOut || Date.now() >= workerData.deadlineAt) {
    outcome = { timeout: true };
  } else {
    if (workerData.repo.includes("/") && !qualified.has(workerData.repo)) qualified.add(workerData.repo);
    const aliases = qualified.size === 1
      ? [...new Set([workerData.repo, basename, ...qualified])]
      : [workerData.repo];
    outcome = { matched, aliases };
  }
} catch {}
try { db?.close(); } catch {}
parentPort.postMessage(outcome);
`;
}

/**
 * Compare a tiny set of cloud-text hashes against every local status without
 * materializing local text on the main thread or moving it across workers.
 */
export function findLocalTextHashMatches(
  dbPath: string,
  repo: string,
  candidateHashes: readonly string[],
  remainingMs: number,
): Promise<QueryDedupeResult | "timeout" | null> {
  const hashes = [...new Set(candidateHashes)].slice(0, MAX_CANDIDATES);
  if (hashes.length === 0 || remainingMs <= 0) return Promise.resolve("timeout");
  if (workerInFlight) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let worker: WorkerHandle | undefined;
    let stopping: Promise<void> | undefined;
    let hasBufferedResult = false;
    let bufferedResult: QueryDedupeResult | "timeout" | null = null;
    const stop = () => {
      if (!worker) {
        workerInFlight = false;
        return Promise.resolve();
      }
      stopping ??= worker.terminate().catch(() => undefined).then(() => { workerInFlight = false; });
      return stopping;
    };
    const finish = (result: QueryDedupeResult | "timeout" | null, workerClosed = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (workerClosed) workerInFlight = false;
      else void stop();
      resolve(result);
    };
    try {
      const modulePath = betterSqlite3Path ??= require.resolve("better-sqlite3");
      workerInFlight = true;
      worker = workerFactory(makeWorkerSource(modulePath), {
        eval: true,
        workerData: { dbPath, repo, candidateHashes: hashes, deadlineAt: Date.now() + remainingMs },
        resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 16 },
      });
      worker.unref?.();
    } catch {
      finish(null);
      return;
    }
    timer = setTimeout(() => finish("timeout"), remainingMs);
    worker.once("message", (value: unknown) => {
      const message = value as { matched?: unknown; aliases?: unknown; timeout?: unknown };
      hasBufferedResult = true;
      if (message.timeout) bufferedResult = "timeout";
      else if (Array.isArray(message.matched) && Array.isArray(message.aliases)) {
        const matchedHashes = new Set(message.matched.filter((hash): hash is string => typeof hash === "string" && hashes.includes(hash)));
        const repoAliases = new Set(message.aliases.filter((alias): alias is string => typeof alias === "string"));
        bufferedResult = { matchedHashes, repoAliases };
      }
      void stop().then(() => finish(bufferedResult, true));
    });
    worker.once("error", () => finish(null));
    worker.once("exit", () => finish(hasBufferedResult ? bufferedResult : null, true));
  });
}

export function setQueryDedupeWorkerFactoryForTests(factory?: WorkerFactory): void {
  workerFactory = factory ?? ((source, options) => new Worker(source, options));
}

export function resetQueryDedupeWorkerForTests(): void {
  workerFactory = (source, options) => new Worker(source, options);
  workerInFlight = false;
}
