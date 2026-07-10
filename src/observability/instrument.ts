/**
 * Side-effecting Sentry bootstrap.
 *
 * Import this FIRST — before any other module — at each long-running or
 * user-facing entrypoint so Sentry (if, and only if, `SENTRY_DSN` is set)
 * installs its error handlers before any other code runs:
 *
 *   import "./observability/instrument.js";
 *
 * With `SENTRY_DSN` unset this is a hard no-op: no init, no network. See
 * {@link ./sentry.ts} for the full opt-in contract.
 */

import { initSentry } from "./sentry.js";

initSentry();
