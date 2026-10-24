// Recall-authored (not part of the upstream recall-cloud engine; see PROVENANCE.md).
//
// Runs the unmodified recall-sync.mjs `watch` loop inside this process and ties
// its lifetime to the Recall daemon that forked it. The IPC channel closes when
// the daemon exits for any reason, including SIGKILL, so the sync loop can never
// keep uploading after the daemon is gone. No PID files are involved.
//
// usage (forked with an IPC channel): node managed-worker.mjs <engine.mjs> watch [engine flags]
import { pathToFileURL } from "node:url";

const [enginePath, ...engineArgs] = process.argv.slice(2);
if (typeof process.send !== "function" || !enginePath) {
  console.error("managed-worker requires an IPC channel and an engine path");
  process.exit(2);
}

const initialParent = process.ppid;
const quit = () => process.exit(0);

process.on("disconnect", quit);
process.on("message", (message) => {
  if (message && message.type === "stop") quit();
});
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
// Second line of defence if the IPC close were ever missed.
setInterval(() => {
  if (process.ppid !== initialParent) quit();
}, 1000).unref();

// Bound every network call, including reading the response body: the timeout
// signal is never cleared on headers, and it is combined with any caller signal.
const REQUEST_TIMEOUT_MS = Number(process.env.RECALL_CLOUD_REQUEST_TIMEOUT_MS) || 30_000;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return nativeFetch(input, { ...init, signal });
};

// The engine only runs main() when process.argv[1] is its own path.
process.argv = [process.execPath, enginePath, ...engineArgs];
try {
  await import(pathToFileURL(enginePath).href);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
