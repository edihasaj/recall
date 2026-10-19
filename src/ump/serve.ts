/**
 * `recall ump` - serve the Universal Memory Protocol over Recall's engine.
 *
 * Recall becomes a conforming UMP provider: any MCP host (Claude Code, Codex,
 * other agents) can `ump.recall` / `ump.get` the memories Recall has learned,
 * and `ump.remember` stores records directly as active Recall memories (fast,
 * round-trips by id). Pass `smart: true` to route writes through Recall's
 * capture/judgement pipeline instead.
 */

import {
  UmpServer,
  createHttpServer,
  createMcpServer,
  type KeyPair,
} from "@universalmemoryprotocol/core";
import { RecallStore, fromAmpId } from "@universalmemoryprotocol/core/adapters/recall";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initDb } from "../db/client.js";
import {
  loadEmbeddingConfigFromEnv,
  ensureEmbeddingProviderReady,
  bootstrapEmbeddings,
} from "../embeddings/embeddings.js";
import { makeRecallBackend } from "./backend.js";
import { loadPersistedUmpOperatorKey } from "./identity.js";
import { signalOutcomeFallback } from "../mcp/fallback.js";
import type { RecallDb } from "../db/client.js";

export interface UmpServeOptions {
  /** Serve the HTTP binding on this port. */
  http?: number;
  /** Serve the MCP binding over stdio (default when no http port given). */
  stdio?: boolean;
  /** Route writes through Recall's capture/judgement pipeline instead of storing directly. */
  smart?: boolean;
  /** Test-only or embedding override. Production loads the persisted operator key. */
  key?: KeyPair;
}

export function createRecallUmpServer(
  db: RecallDb,
  opts: Pick<UmpServeOptions, "smart" | "key"> = {},
): { server: UmpServer; owner: string } {
  const dbPath = db.$client.name;
  if (!opts.key && (!dbPath || dbPath === ":memory:" || dbPath.startsWith("file::memory:"))) {
    throw new Error("In-memory Recall UMP servers require an injected operator key");
  }
  const key = opts.key ?? loadPersistedUmpOperatorKey(dbPath);
  const owner = key.did;
  const server = new UmpServer({
    name: "recall",
    version: "ump-1.0.3",
    conformance: "L1",
    store: new RecallStore(makeRecallBackend(db, owner), { owner, smart: opts.smart }),
    key,
    onFeedback: async (req) => {
      signalOutcomeFallback(db, {
        memory_id: fromAmpId(req.id),
        session_id: req.session ?? `ump:${process.pid}`,
        injected: true,
        outcome: req.outcome,
        context: "ump.feedback",
      }, "mcp:ump");
    },
  });
  return { server, owner };
}

export async function runUmpServer(opts: UmpServeOptions = {}): Promise<void> {
  const db = initDb();

  // Warm the local embedding model and index existing memories so `ump.recall`
  // does real semantic (vector + FTS) retrieval, not lexical fallback. Disable
  // with RECALL_EMBEDDINGS_DISABLED=true.
  const embedCfg = loadEmbeddingConfigFromEnv();
  if (embedCfg) {
    try {
      process.stderr.write(`[recall ump] loading embedding model ${embedCfg.model}...\n`);
      await ensureEmbeddingProviderReady(embedCfg);
      const n = await bootstrapEmbeddings(db, embedCfg);
      process.stderr.write(`[recall ump] semantic search ready (${n} memories indexed)\n`);
    } catch (e) {
      process.stderr.write(
        `[recall ump] embeddings unavailable (${e instanceof Error ? e.message : String(e)}); using lexical search\n`,
      );
    }
  }

  const { server, owner } = createRecallUmpServer(db, opts);

  if (opts.http) {
    createHttpServer(server, { wellKnown: { owner } }).listen(opts.http, () => {
      process.stderr.write(
        `[recall ump] HTTP binding on :${opts.http} (owner ${owner})\n`,
      );
    });
  }

  if (opts.stdio ?? !opts.http) {
    await createMcpServer(server, { owner }).connect(new StdioServerTransport());
    process.stderr.write(`[recall ump] MCP binding on stdio (owner ${owner})\n`);
  }
}
