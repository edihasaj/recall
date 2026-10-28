import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Whether a Codex thread's prompts were written by a person or by another
 * program. Codex records the thread origin in the first rollout line
 * (`session_meta.payload.source`): interactive surfaces use `cli` or
 * `vscode` (the desktop app), while `exec` runs, spawned subagents and
 * `codex mcp-server` sessions receive prompts written by an agent or script.
 *
 * Those prompts reach the same UserPromptSubmit hook as a typed message.
 * Treating them as the user's words turned task briefs ("Do not use uv",
 * "reply with the model name it runs as") into durable rules, and repeating
 * a scripted run promoted them. Recall still injects memory into automated
 * threads; it only stops learning corrections from their prompts.
 */
const AUTOMATED_SOURCES: ReadonlySet<string> = new Set(["exec", "subagent", "mcp"]);
/** Observed first lines are about 55 KB, dominated by base instructions. */
const MAX_META_BYTES = 512 * 1024;
const CHUNK_BYTES = 64 * 1024;

/** The `session_meta` source of a plain `.jsonl` rollout, or null when unknown. */
export function readCodexThreadSource(transcriptPath: unknown): string | null {
  if (typeof transcriptPath !== "string" || !transcriptPath.endsWith(".jsonl")) return null;
  const firstLine = readFirstLine(transcriptPath);
  if (!firstLine) return null;
  try {
    const record = JSON.parse(firstLine) as { type?: unknown; payload?: Record<string, unknown> };
    if (record.type !== "session_meta" || !record.payload) return null;
    const source = record.payload.source;
    if (typeof source === "string") return source;
    if (source && typeof source === "object" && !Array.isArray(source)) {
      return Object.keys(source)[0] ?? null;
    }
    return typeof record.payload.thread_source === "string" ? record.payload.thread_source : null;
  } catch {
    return null;
  }
}

/** True only on positive evidence; an unreadable rollout counts as interactive. */
export function isAutomatedCodexThread(transcriptPath: unknown): boolean {
  const source = readCodexThreadSource(transcriptPath);
  return source !== null && AUTOMATED_SOURCES.has(source);
}

export function isAutomatedCodexSource(source: string | null): boolean {
  return source !== null && AUTOMATED_SOURCES.has(source);
}

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Finds the local rollout for a Codex thread id. Live rollouts sit under
 * `sessions/YYYY/MM/DD` by local start date, so only the days around
 * `startedAt` are listed; archived rollouts share one flat directory, listed
 * once per locator. Returns null for non-thread ids and threads from another
 * machine.
 */
export function createCodexRolloutLocator(codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")) {
  const dirCache = new Map<string, string[]>();
  const list = (dir: string): string[] => {
    let entries = dirCache.get(dir);
    if (!entries) {
      try {
        entries = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
      } catch {
        entries = [];
      }
      dirCache.set(dir, entries);
    }
    return entries;
  };
  return (threadId: string, startedAt?: string): string | null => {
    if (!THREAD_ID.test(threadId)) return null;
    const suffix = `-${threadId}.jsonl`;
    const hint = startedAt ? Date.parse(startedAt) : Number.NaN;
    if (Number.isFinite(hint)) {
      for (const offset of [0, -1, 1]) {
        const day = new Date(hint + offset * 86_400_000);
        const dir = join(
          codexHome,
          "sessions",
          String(day.getFullYear()),
          String(day.getMonth() + 1).padStart(2, "0"),
          String(day.getDate()).padStart(2, "0"),
        );
        const match = list(dir).find((name) => name.endsWith(suffix));
        if (match) return join(dir, match);
      }
    }
    const archived = join(codexHome, "archived_sessions");
    const match = list(archived).find((name) => name.endsWith(suffix));
    return match ? join(archived, match) : null;
  };
}

function readFirstLine(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < MAX_META_BYTES) {
      const chunk = Buffer.alloc(CHUNK_BYTES);
      const read = readSync(fd, chunk, 0, CHUNK_BYTES, total);
      if (read <= 0) break;
      const newline = chunk.subarray(0, read).indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        return Buffer.concat(chunks).toString("utf-8");
      }
      chunks.push(chunk.subarray(0, read));
      total += read;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
