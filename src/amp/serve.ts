/**
 * `recall amp` - serve the Agent Memory Protocol over Recall's engine.
 *
 * Recall becomes a conforming AMP provider: any MCP host (Claude Code, Codex,
 * other agents) can `amp.recall` / `amp.get` the memories Recall has learned,
 * and `amp.remember` routes corrections back into Recall's capture pipeline.
 *
 * This is a read-focused provider (L1): Recall owns memory lifecycle, so AMP
 * `revise`/`forget` map to Recall's own supersession/prune rather than verbatim
 * record edits. Reads (`recall`/`get`) return Recall memories as AMP records.
 */

import {
  AmpServer,
  generateKeyPair,
  createHttpServer,
  createMcpServer,
} from "@amp/core";
import { RecallStore } from "@amp/core/adapters/recall";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initDb } from "../db/client.js";
import { makeRecallBackend } from "./backend.js";

export interface AmpServeOptions {
  /** Serve the HTTP binding on this port. */
  http?: number;
  /** Serve the MCP binding over stdio (default when no http port given). */
  stdio?: boolean;
}

export async function runAmpServer(opts: AmpServeOptions = {}): Promise<void> {
  const db = initDb();
  const key = generateKeyPair();
  const owner = key.did;

  const server = new AmpServer({
    name: "recall",
    version: "amp-0.1",
    conformance: "L1",
    store: new RecallStore(makeRecallBackend(db), { owner }),
    key,
  });

  if (opts.http) {
    createHttpServer(server, { wellKnown: { owner } }).listen(opts.http, () => {
      process.stderr.write(
        `[recall amp] HTTP binding on :${opts.http} (owner ${owner})\n`,
      );
    });
  }

  if (opts.stdio ?? !opts.http) {
    await createMcpServer(server).connect(new StdioServerTransport());
    process.stderr.write(`[recall amp] MCP binding on stdio (owner ${owner})\n`);
  }
}
