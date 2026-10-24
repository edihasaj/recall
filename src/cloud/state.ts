import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CloudConfig } from "./config.js";
import { CloudError } from "./errors.js";
import { writePrivateFile } from "./private-files.js";

/** Same key the engine derives for its cursor entry: sha256(api \0 deviceId \0 dbPath). */
export function engineStateKey(config: Pick<CloudConfig, "api" | "deviceId" | "dbPath">): string {
  return createHash("sha256")
    .update(`${config.api}\0${config.deviceId}\0${resolve(config.dbPath)}`)
    .digest("hex");
}

/**
 * A newly pasted token may belong to a different account on the same API, so the
 * old push/pull cursors cannot be trusted. Clearing only fullReconciledAt for this
 * device's entry makes the engine's first cycle a full reconcile, while keeping the
 * cursors, device identity and every other device's entry untouched.
 */
export function requestFullReconcile(config: CloudConfig): boolean {
  let state: { entries?: Record<string, unknown> } | null = null;
  try {
    if (!existsSync(config.stateFile)) return false;
    state = JSON.parse(readFileSync(config.stateFile, "utf8"));
  } catch {
    // Missing or unreadable state already makes the engine do a full reconcile.
    return false;
  }
  const entry = state?.entries?.[engineStateKey(config)];
  if (!entry || typeof entry !== "object") return false;
  (entry as Record<string, unknown>).fullReconciledAt = null;
  try {
    writePrivateFile(config.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // The old cursor would be trusted for a possibly different account: fail closed.
    throw new CloudError(
      "Recall could not reset the sync position for the new token, so Connect was not completed. Nothing is syncing.",
      "config-invalid",
      500,
    );
  }
  return true;
}
