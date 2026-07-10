/**
 * Optional, opt-in Sentry error reporting.
 *
 * Errors and crashes only — no performance tracing, no profiling, no session
 * replay, no default PII. The DSN comes exclusively from the `SENTRY_DSN`
 * environment variable; when it is empty or unset, {@link initSentry} is a hard
 * no-op and `Sentry.init` is never called, so the SDK sends nothing off-box.
 *
 * Recall is public OSS: community installs never phone home unless the operator
 * explicitly sets `SENTRY_DSN`. The DSN is intentionally NOT baked into source.
 *
 * The `@sentry/node` SDK installs its own `onUncaughtException` /
 * `onUnhandledRejection` handlers by default once initialized, so unhandled
 * crashes in a long-running process (daemon, sync server, MCP server) are
 * captured automatically.
 */

import * as Sentry from "@sentry/node";

let initialized = false;

/**
 * Initialize Sentry iff `SENTRY_DSN` is set. Safe (and cheap) to call once at
 * each entrypoint's first side-effect. Returns whether Sentry was initialized.
 */
export function initSentry(): boolean {
  if (initialized) return true;

  const dsn = process.env.SENTRY_DSN?.trim();
  // Hard no-op without a DSN — the critical OSS guarantee. No init, no network.
  if (!dsn) return false;

  const environment =
    process.env.RECALL_ENV?.trim() ||
    process.env.NODE_ENV?.trim() ||
    "production";

  Sentry.init({
    dsn,
    environment,
    // Errors/crashes only — no performance traffic.
    tracesSampleRate: 0,
    // No profiling, no replay: keep only the error integrations.
    profilesSampleRate: 0,
    // Don't attach client IP, cookies, or any user identity.
    sendDefaultPii: false,
  });

  initialized = true;
  return true;
}

export { Sentry };
