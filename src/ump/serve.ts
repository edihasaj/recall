/**
 * `recall ump` - serve the Universal Memory Protocol over Recall's engine.
 *
 * Recall becomes a conforming UMP provider: any MCP host (Claude Code, Codex,
 * other agents) can `ump.recall` / `ump.get` the memories Recall has learned,
 * and `ump.remember` routes corrections back into Recall's capture pipeline.
 *
 * This is a read-focused provider (L1): Recall owns memory lifecycle, so UMP
 * `revise`/`forget` map to Recall's own supersession/prune rather than verbatim
 * record edits. Reads (`recall`/`get`) return Recall memories as UMP records.
 */

import {
  UmpServer,
  generateKeyPair,
  createHttpServer,
  createMcpServer,
} from "@ump/core";
import { RecallStore } from "@ump/core/adapters/recall";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initDb } from "../db/client.js";
import { makeRecallBackend } from "./backend.js";

export interface UmpServeOptions {
  /** Serve the HTTP binding on this port. */
  http?: number;
  /** Serve the MCP binding over stdio (default when no http port given). */
  stdio?: boolean;
}

export async function runUmpServer(opts: UmpServeOptions = {}): Promise<void> {
  const db = initDb();
  const key = generateKeyPair();
  const owner = key.did;

  const server = new UmpServer({
    name: "recall",
    version: "ump-0.1",
    conformance: "L1",
    store: new RecallStore(makeRecallBackend(db), { owner }),
    key,
  });

  if (opts.http) {
    createHttpServer(server, { wellKnown: { owner } }).listen(opts.http, () => {
      process.stderr.write(
        `[recall ump] HTTP binding on :${opts.http} (owner ${owner})\n`,
      );
    });
  }

  if (opts.stdio ?? !opts.http) {
    await createMcpServer(server).connect(new StdioServerTransport());
    process.stderr.write(`[recall ump] MCP binding on stdio (owner ${owner})\n`);
  }
}
