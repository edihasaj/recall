import type { RecallDb } from "../db/client.js";

// The daemon's Cloud refresher and maintenance share this connection. Both
// rebuild indexes across awaits, so their verify/rebuild passes must serialize.
const tails = new WeakMap<object, Promise<void>>();

export async function withMemoryIndexLock<T>(db: RecallDb, operation: () => Promise<T>): Promise<T> {
  const prior = tails.get(db.$client) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  tails.set(db.$client, current);
  await prior;
  try { return await operation(); }
  finally {
    release();
    if (tails.get(db.$client) === current) tails.delete(db.$client);
  }
}
