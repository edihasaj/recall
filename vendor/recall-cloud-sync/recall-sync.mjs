#!/usr/bin/env node
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyPulledRecords,
  decryptCloudPayload,
  canonicalExternalId,
  cloudExternalIdForRow
} from "./recall-sync-local.mjs";
import {
  normalizeToken,
  readPrivateTokenFile,
  validateApiUrl,
  validatePrivateFile,
  writePrivateFileAtomic,
  writePrivateTokenFile
} from "./private-token.mjs";

const DEFAULT_DB = join(homedir(), ".recall", "recall.db");
const SELF = fileURLToPath(import.meta.url);
const LAUNCHD_LABEL = "dev.recallmemory.cloud-sync";
const SYSTEMD_UNIT = "recall-cloud-sync.service";
const WINDOWS_TASK = "Recall Cloud Sync";
const TOKEN_FILE = join(homedir(), ".config", "recall-cloud", "token");
const SYNC_STATE_FILE = join(homedir(), ".config", "recall-cloud", "sync-state.json");
// transient is deliberately excluded: it is by definition not durable, and the
// pull side has no inverse for the push-time transient→candidate coercion, so
// syncing it silently promoted local transient rows to candidate on the next
// pull. rejected IS synced — cross-device rejection propagation depends on it;
// the billing count excludes rejected server-side instead.
const DEFAULT_PUSH_STATUSES = "active,candidate,rejected";
const DEFAULT_WATCH_STATUSES = "active,candidate,rejected";
const DEFAULT_FULL_RECONCILE_SECONDS = 86_400;

// --- E2EE (zero-knowledge) client-side encryption -------------------------
// A deterministic content key is derived from the user's passphrase so every
// device that knows the passphrase derives the SAME key — no server key
// exchange needed. The server only ever sees ciphertext + nonce; it never sees
// the passphrase, the derived key, or plaintext. AES-256-GCM (via Node crypto);
// the server treats the blobs as opaque, so the exact AEAD is a client choice.
const E2EE_KDF_SALT = "recall-cloud-e2ee-v1";
const E2EE_KEY_ID = "pp-v1";
const GCM_TAG_BYTES = 16;

function e2eeKey(passphrase) {
  return scryptSync(Buffer.from(String(passphrase), "utf8"), E2EE_KDF_SALT, 32);
}

function e2eeEncrypt(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  // store ciphertext||authTag as one opaque blob; nonce travels alongside.
  const blob = Buffer.concat([body, cipher.getAuthTag()]);
  return { ciphertext: blob.toString("base64"), nonce: iv.toString("base64") };
}

function e2eeDecrypt(key, ciphertextB64, nonceB64) {
  const blob = Buffer.from(String(ciphertextB64), "base64");
  const iv = Buffer.from(String(nonceB64), "base64");
  const body = blob.subarray(0, blob.length - GCM_TAG_BYTES);
  const tag = blob.subarray(blob.length - GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

// Resolve E2EE config from flags/env. Returns null when off; throws if enabled
// without a passphrase (fail closed rather than silently sync plaintext).
function resolveE2ee(options) {
  if (!options.e2ee) return null;
  const passphrase = options.e2eePassphrase ?? process.env.RECALL_CLOUD_E2EE_PASSPHRASE;
  if (!passphrase) {
    throw new Error("--e2ee requires a passphrase (--e2ee-passphrase or RECALL_CLOUD_E2EE_PASSPHRASE)");
  }
  return { key: e2eeKey(passphrase) };
}

// Run main() only when executed directly, so the module can be imported by
// tests. Compare realpath-resolved paths so a symlinked location (e.g. macOS
// /var -> /private/var) still counts as "invoked directly".
let INVOKED_DIRECTLY = false;
try {
  INVOKED_DIRECTLY = Boolean(process.argv[1]) && realpathSync(SELF) === realpathSync(process.argv[1]);
} catch {
  INVOKED_DIRECTLY = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}
if (INVOKED_DIRECTLY) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export {
  DEFAULT_PUSH_STATUSES,
  DEFAULT_WATCH_STATUSES,
  applyPulledRecords,
  canonicalExternalId,
  cloudExternalIdForRow,
  e2eeKey,
  e2eeEncrypt,
  e2eeDecrypt,
  resolveE2ee,
  buildPlist,
  buildSystemdUnit,
  buildWindowsLauncher,
  launchAgentArgs,
  parseDeviceAliases,
  deviceAliasesFromArgs,
  resolveDeviceAliases,
  deviceIdFromArgs,
  legacyTokenFromArgs,
  loadSyncState,
  readPrivateTokenFile,
  readRecallMemories,
  toCloudRecord
};

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = parseOptions(args);

  switch (command) {
    case "push":
      await push(options);
      break;
    case "pull":
      await pull(options);
      break;
    case "verify":
      await verify(options);
      break;
    case "memories":
    case "list-all":
      await memories(options);
      break;
    case "watch":
      await watch(options);
      break;
    case "install":
      await installAgent(options);
      break;
    case "uninstall":
      await uninstallAgent(options);
      break;
    default:
      usage();
      process.exit(command ? 1 : 0);
  }
}

async function push(options, { verifiedE2ee = false } = {}) {
  const api = requiredApi(options.api ?? process.env.RECALL_CLOUD_API);
  const token = resolveToken(options);
  const dbPath = resolve(expandHome(options.db ?? process.env.RECALL_DB ?? DEFAULT_DB));
  const statusSet = new Set((options.status ?? DEFAULT_PUSH_STATUSES).split(",").map((value) => value.trim()).filter(Boolean));
  const deviceId = options.deviceId ?? hostnameLabel();
  const deviceAliases = resolveDeviceAliases(options);
  const limit = parseInteger(options.limit, 5000);
  const dryRun = Boolean(options.dryRun);
  const e2ee = resolveE2ee(options);

  const rows = readRecallMemories(dbPath, statusSet, limit, {
    after: options.after,
    afterId: options.afterId
  });
  const records = rows.map((row) => toCloudRecord(row, deviceId, e2ee, deviceAliases));

  if (dryRun) {
    console.log(JSON.stringify(dryRunPushPayload(records, {
      dbPath,
      api,
      deviceId,
      e2ee: Boolean(e2ee),
      statuses: [...statusSet],
      includeSample: Boolean(options.sample)
    }), null, 2));
    return;
  }

  // A mistyped key on a new device must not overwrite existing ciphertext.
  // Watch verifies through its preceding pull; standalone push verifies here.
  if (e2ee && !verifiedE2ee) await verifyRemoteEncryption(api, token, e2ee);

  let accepted = 0;
  // Rows the server actually wrote. `accepted` only counts records that
  // survived the ACL filter; the updated_at guard can still drop stale ones,
  // so "pushed=500" could mean zero writes.
  let applied = 0;
  let aliasesReconciled = 0;
  const batches = chunks(records, 500);
  if (batches.length === 0 && Object.keys(deviceAliases).length > 0) batches.push([]);
  for (const [index, batch] of batches.entries()) {
    const result = await fetchJson(`${api}/v1/sync/push`, {
      method: "POST",
      token,
      body: syncPushRequest(batch, index === 0 ? deviceAliases : {})
    });
    accepted += Number(result.accepted ?? 0);
    // Older servers don't report `applied`; fall back to accepted so the
    // number never reads as a spurious zero.
    applied += Number(result.applied ?? result.accepted ?? 0);
    aliasesReconciled += Number(result.aliasesReconciled ?? 0);
  }

  if (options.quiet) {
    console.log(`[${new Date().toISOString()}] push ok applied=${applied} accepted=${accepted} selected=${records.length} aliases=${aliasesReconciled} device=${deviceId}`);
  } else {
    console.log(JSON.stringify({
      pushed: accepted,
      applied,
      selected: records.length,
      dbPath,
      api,
      deviceId,
      aliasesReconciled,
      statuses: [...statusSet]
    }, null, 2));
  }
  const last = rows.at(-1);
  return {
    pushed: accepted,
    applied,
    selected: records.length,
    aliasesReconciled,
    cursor: last ? { updatedAt: last.updated_at, id: last.id } : null
  };
}

export function syncPushRequest(records, deviceAliases = {}) {
  const body = { records };
  if (Object.keys(deviceAliases).length > 0) body.deviceAliases = deviceAliases;
  return body;
}

export function dryRunPushPayload(records, { dbPath, api, deviceId, e2ee, statuses, includeSample = false }) {
  const payload = {
    dryRun: true,
    dbPath,
    api,
    deviceId,
    e2ee,
    selected: records.length,
    statuses
  };
  if (includeSample) payload.sample = records.slice(0, 3);
  return payload;
}

async function pull(options) {
  const api = requiredApi(options.api ?? process.env.RECALL_CLOUD_API);
  const token = resolveToken(options);
  const dbPath = resolve(expandHome(options.db ?? process.env.RECALL_DB ?? DEFAULT_DB));
  const deviceId = options.deviceId ?? hostnameLabel();
  const deviceAliases = resolveDeviceAliases(options);
  const max = parseInteger(options.limit, 100000);
  const records = await fetchAllSyncRecords({
    api,
    token,
    since: options.since,
    sinceId: options.sinceId,
    max
  });
  const applied = options.dryRun
    ? {
        imported: 0,
        updated: 0,
        unchanged: 0,
        skippedEncrypted: records.filter((record) => record.encryptionMode === "e2ee").length,
        skippedDuplicate: 0,
        skippedExpiredTombstone: 0
      }
    : applyPulledRecords(dbPath, records, {
        deviceId,
        deviceAliases,
        e2ee: resolveE2ee(options),
        decrypt: e2eeDecrypt,
        rejectedRetentionDays: parseNonNegativeInteger(
          options.rejectedRetentionDays ?? process.env.RECALL_REJECTED_RETENTION_DAYS,
          90
        )
      });

  if (options.quiet) {
    console.log(
      `[${new Date().toISOString()}] pull ok fetched=${records.length} imported=${applied.imported} updated=${applied.updated} unchanged=${applied.unchanged} skipped=${applied.skippedEncrypted + applied.skippedDuplicate + applied.skippedExpiredTombstone}`
    );
  } else {
    console.log(JSON.stringify({
      fetched: records.length,
      dbPath,
      dryRun: Boolean(options.dryRun),
      ...applied
    }, null, 2));
  }
  const last = records.at(-1);
  return {
    fetched: records.length,
    ...applied,
    cursor: last?.updatedAt && last?.externalId
      ? { updatedAt: last.updatedAt, id: last.externalId }
      : null
  };
}

async function verify(options) {
  const api = requiredApi(options.api ?? process.env.RECALL_CLOUD_API);
  const token = resolveToken(options);
  const query = options.query ?? "recall";
  const limit = parseInteger(options.limit, 10);

  const result = await fetchJson(`${api}/v1/compile`, {
    method: "POST",
    token,
    body: { query, limit }
  });

  const memories = Array.isArray(result.memories) ? result.memories : [];
  console.log(JSON.stringify({
    query,
    matched: memories.length,
    mode: result.mode,
    sample: memories.slice(0, 5)
  }, null, 2));
}

async function memories(options) {
  const api = requiredApi(options.api ?? process.env.RECALL_CLOUD_API);
  const token = resolveToken(options);
  const queryFilter = (options.query ?? "").toLowerCase();
  const deviceFilter = options.device ?? null;
  const max = parseInteger(options.limit, 100000);

  const all = await fetchAllSyncRecords({
    api,
    token,
    since: options.since,
    max
  });

  // With a passphrase, decrypt e2ee rows client-side so they are readable/
  // searchable locally (the server never could). Rows that don't decrypt with
  // this passphrase are left as-is (shown as [encrypted]).
  const e2ee = resolveE2ee(options);
  let rows = all;
  if (e2ee) {
    rows = rows.map((r) => {
      if (r.encryptionMode !== "e2ee" || !r.contentCiphertext) return r;
      try {
        const payload = JSON.parse(e2eeDecrypt(e2ee.key, r.contentCiphertext, r.contentNonce));
        return { ...r, contentPlaintext: payload.text, metadata: { ...(r.metadata ?? {}), recall: payload.recall } };
      } catch {
        return { ...r, contentPlaintext: "[encrypted: wrong passphrase]" };
      }
    });
  }
  if (deviceFilter) rows = rows.filter((r) => String(r.externalId ?? "").split(":")[0] === deviceFilter);
  if (queryFilter) rows = rows.filter((r) => String(r.contentPlaintext ?? "").toLowerCase().includes(queryFilter));

  const show = parseNonNegativeInteger(options.show, 40);
  if (options.json) {
    console.log(JSON.stringify(memoryRowsForOutput(rows, options.show == null ? null : show), null, 2));
    return;
  }

  const byDevice = {};
  for (const r of rows) {
    const device = String(r.externalId ?? "?").split(":")[0];
    byDevice[device] = (byDevice[device] ?? 0) + 1;
  }
  console.log(`Memories: ${rows.length}${queryFilter ? ` matching "${queryFilter}"` : ""}${deviceFilter ? ` on ${deviceFilter}` : ""} across ${Object.keys(byDevice).length} device(s)`);
  console.log(Object.entries(byDevice).sort((a, b) => b[1] - a[1]).map(([d, n]) => `  ${d}: ${n}`).join("\n"));
  console.log("");
  if (show === 0) return;
  for (const r of rows.slice(0, show)) {
    const device = String(r.externalId ?? "?").split(":")[0];
    const conf = Number(r.confidence ?? 0).toFixed(2);
    const text = String(r.contentPlaintext ?? "").replace(/\s+/g, " ").slice(0, 96);
    console.log(`  [${device}] (${r.kind}/${conf}) ${text}`);
  }
  if (rows.length > show) console.log(`  … and ${rows.length - show} more (use --show N or --json)`);
}

export function memoryRowsForOutput(rows, show) {
  if (show == null) return rows;
  return rows.slice(0, show);
}

async function watch(options) {
  const api = requiredApi(options.api ?? process.env.RECALL_CLOUD_API);
  const token = resolveToken(options);
  const intervalSeconds = parseInteger(options.interval, 300);
  const fullReconcileSeconds = parseInteger(
    options.fullReconcileInterval,
    DEFAULT_FULL_RECONCILE_SECONDS
  );
  const loopOptions = { ...options, token, tokenFile: undefined, tokenStdin: undefined, quiet: true };
  // Rejected rows are tombstones: uploading their status transition removes
  // formerly-active memories from hosted search instead of leaving stale cloud
  // copies behind forever.
  if (!loopOptions.status) loopOptions.status = DEFAULT_WATCH_STATUSES;
  const dbPath = resolve(expandHome(options.db ?? process.env.RECALL_DB ?? DEFAULT_DB));
  const deviceId = options.deviceId ?? hostnameLabel();
  const deviceAliases = resolveDeviceAliases(options);
  loopOptions.deviceAlias = Object.entries(deviceAliases).map(([from, to]) => `${from}=${to}`);
  const statePath = resolve(expandHome(options.stateFile ?? SYNC_STATE_FILE));
  const stateKey = createHash("sha256")
    .update(`${api}\0${deviceId}\0${dbPath}`)
    .digest("hex");
  const state = loadSyncState(statePath);
  const cursor = state.entries[stateKey] ?? {
    api,
    deviceId,
    dbPath,
    push: null,
    pull: null,
    fullReconciledAt: null
  };

  console.log(
    `[recall-cloud] watch started api=${api} db=${dbPath} interval=${intervalSeconds}s device=${deviceId}`
  );

  let running = true;
  const stop = (signal) => {
    console.log(`[recall-cloud] received ${signal}, stopping watch`);
    running = false;
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  const privateSync = resolveE2ee(loopOptions);
  let needsKeyVerification = Boolean(privateSync);
  while (running) {
    try {
      const lastFullMs = Date.parse(String(cursor.fullReconciledAt ?? ""));
      const fullReconcile = needsKeyVerification || !Number.isFinite(lastFullMs)
        || Date.now() - lastFullMs >= fullReconcileSeconds * 1000;
      // Verify/import encrypted data before any upload, even with saved cursors.
      // Failed decryption rolls back the pull and never advances its cursor.
      if (privateSync) {
        // Key verification must not inherit the user's incremental batch limit.
        if (needsKeyVerification) await retryTransientSync(() => verifyRemoteEncryption(api, token, privateSync));
        const verified = await retryTransientSync(() => retrySqliteBusy(() => pull({
          ...loopOptions,
          since: fullReconcile ? undefined : cursor.pull?.updatedAt,
          sinceId: fullReconcile ? undefined : cursor.pull?.id
        })));
        if (verified.cursor) cursor.pull = verified.cursor;
        needsKeyVerification = false;
      }
      const pushResult = await retryTransientSync(() => push({
        ...loopOptions,
        after: fullReconcile ? undefined : cursor.push?.updatedAt,
        afterId: fullReconcile ? undefined : cursor.push?.id
      }, { verifiedE2ee: Boolean(privateSync) }));
      if (pushResult?.cursor) cursor.push = pushResult.cursor;
      state.entries[stateKey] = cursor;
      saveSyncState(statePath, state);

      const pullResult = await retryTransientSync(
        () => retrySqliteBusy(() => pull({
          ...loopOptions,
          since: fullReconcile ? undefined : cursor.pull?.updatedAt,
          sinceId: fullReconcile ? undefined : cursor.pull?.id
        }))
      );
      if (pullResult?.cursor) cursor.pull = pullResult.cursor;
      if (fullReconcile) cursor.fullReconciledAt = new Date().toISOString();
      state.entries[stateKey] = cursor;
      saveSyncState(statePath, state);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] sync error: ${error instanceof Error ? error.message : error}`);
    }
    if (!running) break;
    await sleep(intervalSeconds * 1000, () => running);
  }
  console.log("[recall-cloud] watch stopped");
}

export async function retrySqliteBusy(operation, { attempts = 3, delayMs = 1000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /(?:database is locked|SQLITE_BUSY)/i.test(message);
      if (!retryable || attempt === attempts) throw error;
      console.warn(
        `[${new Date().toISOString()}] local database busy; retrying pull (${attempt}/${attempts})`
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
    }
  }
  throw new Error("unreachable SQLite retry state");
}

export async function retryTransientSync(operation, { attempts = 3, delayMs = 1000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        /failed (?:408|425|429|5\d\d)\b/i.test(message) ||
        /(?:fetch failed|network error|invalid JSON response)/i.test(message);
      if (!retryable || attempt === attempts) throw error;
      console.warn(
        `[${new Date().toISOString()}] cloud temporarily unavailable; retrying sync (${attempt}/${attempts})`
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
    }
  }
  throw new Error("unreachable transient sync retry state");
}

// process.execPath is the versioned Homebrew Cellar path (…/Cellar/node@24/24.x/bin/node),
// which disappears when Homebrew upgrades that formula — breaking the launchd
// agent (exit 78). Map it to the same formula's stable opt symlink instead:
// it survives patch upgrades and keeps the Node major that built
// better-sqlite3, so the native module ABI still matches. (The unversioned
// /opt/homebrew/bin/node is avoided: it can jump majors under the agent.)
export function stableNodeBin(execPath = process.execPath, exists = existsSync) {
  const match = execPath.match(/^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/);
  if (match) {
    const optNode = `${match[1]}/opt/${match[2]}/bin/node`;
    if (exists(optNode)) return optNode;
  }
  return execPath;
}

async function installAgent(options) {
  const api = requiredApi(options.api ?? process.env.RECALL_CLOUD_API);
  const plistPath = process.platform === "darwin" ? launchAgentPath() : undefined;
  const token = resolveToken(options, { legacyPlistPath: plistPath });
  const intervalSeconds = String(parseInteger(options.interval, 300));
  const deviceId = options.deviceId ?? hostnameLabel();
  const deviceAliases = resolveDeviceAliases(options, { plistPath });
  const dbPath = resolve(expandHome(options.db ?? process.env.RECALL_DB ?? DEFAULT_DB));
  const nodeBin = process.platform === "darwin" ? stableNodeBin() : process.execPath;

  if (plistPath && existsSync(plistPath) && !options.forceDeviceId) {
    const installedDeviceId = installedDeviceIdFromPlist(plistPath);
    if (installedDeviceId && installedDeviceId !== deviceId) {
      throw new Error(
        `installed sync agent uses device id ${installedDeviceId}; refusing to change to ${deviceId} without --force-device-id`
      );
    }
  }

  writePrivateTokenFile(TOKEN_FILE, token);
  if (process.platform === "linux") {
    installSystemdAgent({ api, intervalSeconds, deviceId, dbPath, nodeBin, deviceAliases });
    return;
  }
  if (process.platform === "win32") {
    installWindowsAgent({ api, intervalSeconds, deviceId, dbPath, nodeBin, deviceAliases });
    return;
  }
  if (process.platform !== "darwin") {
    throw new Error(`install is not supported on ${process.platform}`);
  }

  const logDir = join(homedir(), "Library", "Logs");
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, "recall-cloud-sync.log");
  mkdirSync(dirname(plistPath), { recursive: true });

  const args = launchAgentArgs({
    self: SELF,
    api,
    tokenFile: TOKEN_FILE,
    intervalSeconds,
    deviceId,
    dbPath,
    deviceAliases
  });
  const plist = buildPlist({ nodeBin, args, logFile });
  writePrivateFileAtomic(plistPath, plist);

  try {
    execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
  } catch {
    // not loaded yet
  }
  execFileSync("launchctl", ["load", plistPath], { stdio: "inherit" });

  console.log(
    JSON.stringify(
      { installed: true, label: LAUNCHD_LABEL, plist: plistPath, log: logFile, intervalSeconds: Number(intervalSeconds), deviceId, dbPath },
      null,
      2
    )
  );
}

async function uninstallAgent() {
  if (process.platform === "linux") {
    uninstallSystemdAgent();
  } else if (process.platform === "win32") {
    uninstallWindowsAgent();
  } else if (process.platform === "darwin") {
    const plistPath = launchAgentPath();
    try {
      execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
    } catch {
      // already unloaded
    }
    if (existsSync(plistPath)) {
      rmSync(plistPath);
    }
  } else {
    throw new Error(`uninstall is not supported on ${process.platform}`);
  }
  if (existsSync(TOKEN_FILE)) {
    validatePrivateFile(TOKEN_FILE);
    rmSync(TOKEN_FILE);
  }
  console.log(JSON.stringify({ uninstalled: true, platform: process.platform }, null, 2));
}

function launchAgentPath() {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function buildPlist({ nodeBin, args, logFile }) {
  const programArgs = [nodeBin, ...args]
    .map((value) => `    <string>${escapeXml(String(value))}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logFile)}</string>
</dict>
</plist>
`;
}

function installSystemdAgent({ api, intervalSeconds, deviceId, dbPath, nodeBin, deviceAliases }) {
  const unitDir = join(homedir(), ".config", "systemd", "user");
  const unitPath = join(unitDir, SYSTEMD_UNIT);
  mkdirSync(unitDir, { recursive: true, mode: 0o700 });
  const args = launchAgentArgs({
    self: SELF,
    api,
    tokenFile: TOKEN_FILE,
    intervalSeconds,
    deviceId,
    dbPath,
    deviceAliases
  });
  writePrivateFileAtomic(unitPath, buildSystemdUnit({ nodeBin, args }));
  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  execFileSync("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT], { stdio: "inherit" });
  console.log(JSON.stringify({
    installed: true,
    platform: "linux",
    service: SYSTEMD_UNIT,
    unit: unitPath,
    logs: `journalctl --user -u ${SYSTEMD_UNIT} -f`,
    intervalSeconds: Number(intervalSeconds),
    deviceId,
    dbPath
  }, null, 2));
}

function uninstallSystemdAgent() {
  const unitPath = join(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT);
  try {
    execFileSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], { stdio: "ignore" });
  } catch {
    // already stopped or user systemd unavailable
  }
  if (existsSync(unitPath)) rmSync(unitPath);
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  } catch {
    // nothing left to reload
  }
}

function buildSystemdUnit({ nodeBin, args }) {
  const command = [nodeBin, ...args].map(systemdQuote).join(" ");
  return `[Unit]
Description=Recall Cloud memory sync
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${command}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

function systemdQuote(value) {
  return `"${String(value).replace(/([\\"])/g, "\\$1")}"`;
}

function installWindowsAgent({ api, intervalSeconds, deviceId, dbPath, nodeBin, deviceAliases }) {
  const configDir = dirname(TOKEN_FILE);
  secureWindowsConfigDirectory(configDir);
  const launcherPath = join(configDir, "watch.ps1");
  const logFile = join(configDir, "sync.log");
  const args = launchAgentArgs({
    self: SELF,
    api,
    tokenFile: TOKEN_FILE,
    intervalSeconds,
    deviceId,
    dbPath,
    deviceAliases
  });
  writePrivateFileAtomic(
    launcherPath,
    buildWindowsLauncher({ nodeBin, args, logFile })
  );
  const escapedLauncherPath = launcherPath.replace(/"/g, '\\"');
  const taskArgs = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${escapedLauncherPath}"`;
  const command = [
    "$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    `$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${powerShellQuote(taskArgs)}`,
    "if ($identity -eq 'NT AUTHORITY\\SYSTEM') { $trigger=New-ScheduledTaskTrigger -AtStartup; $principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest } else { $trigger=New-ScheduledTaskTrigger -AtLogOn -User $identity; $principal=New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited }",
    "$settings=New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries",
    `Register-ScheduledTask -TaskName ${powerShellQuote(WINDOWS_TASK)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
    `Start-ScheduledTask -TaskName ${powerShellQuote(WINDOWS_TASK)}`
  ].join("; ");
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { stdio: "inherit" }
  );
  console.log(JSON.stringify({
    installed: true,
    platform: "win32",
    task: WINDOWS_TASK,
    launcher: launcherPath,
    log: logFile,
    intervalSeconds: Number(intervalSeconds),
    deviceId,
    dbPath
  }, null, 2));
}

function secureWindowsConfigDirectory(configDir) {
  const command = [
    "$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    "$acl=New-Object System.Security.AccessControl.DirectorySecurity",
    "$acl.SetAccessRuleProtection($true,$false)",
    "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')",
    "$acl.SetOwner([System.Security.Principal.NTAccount]$identity)",
    "$acl.SetAccessRule($rule)",
    `Set-Acl -LiteralPath ${powerShellQuote(configDir)} -AclObject $acl`
  ].join("; ");
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { stdio: "inherit" }
  );
}

function uninstallWindowsAgent() {
  const command = [
    `$task=Get-ScheduledTask -TaskName ${powerShellQuote(WINDOWS_TASK)} -ErrorAction SilentlyContinue`,
    `if ($task) { Stop-ScheduledTask -TaskName ${powerShellQuote(WINDOWS_TASK)} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${powerShellQuote(WINDOWS_TASK)} -Confirm:$false }`
  ].join("; ");
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { stdio: "ignore" }
  );
  const launcherPath = join(dirname(TOKEN_FILE), "watch.ps1");
  if (existsSync(launcherPath)) rmSync(launcherPath);
}

function buildWindowsLauncher({ nodeBin, args, logFile }) {
  const invoke = [nodeBin, ...args].map(powerShellQuote).join(" ");
  return `$ErrorActionPreference = 'Continue'
while ($true) {
  & ${invoke} *>> ${powerShellQuote(logFile)}
  Start-Sleep -Seconds 10
}
`;
}

function powerShellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function launchAgentArgs({ self, api, tokenFile, intervalSeconds, deviceId, dbPath, deviceAliases = {} }) {
  const args = [
    self,
    "watch",
    "--api",
    api,
    "--token-file",
    tokenFile,
    "--interval",
    intervalSeconds,
    "--device-id",
    deviceId,
    "--db",
    dbPath
  ];
  for (const [from, to] of Object.entries(deviceAliases).sort(([a], [b]) => a.localeCompare(b))) {
    args.push("--device-alias", `${from}=${to}`);
  }
  return args;
}

function resolveToken(options, { legacyPlistPath } = {}) {
  const explicitSources = [
    options.token ? "token" : null,
    options.tokenFile ? "token-file" : null,
    options.tokenStdin ? "token-stdin" : null
  ].filter(Boolean);
  if (explicitSources.length > 1) {
    throw new Error(`Use only one token source, received: ${explicitSources.join(", ")}`);
  }
  if (options.token) return normalizeToken(options.token);
  if (options.tokenFile) return readPrivateTokenFile(options.tokenFile);
  if (options.tokenStdin) return normalizeToken(readFileSync(0, "utf8"));
  if (process.env.RECALL_CLOUD_TOKEN) return normalizeToken(process.env.RECALL_CLOUD_TOKEN);
  if (legacyPlistPath && existsSync(legacyPlistPath)) {
    const token = legacyTokenFromPlist(legacyPlistPath);
    if (token) return token;
  }
  throw new Error("--token-file, --token-stdin, or RECALL_CLOUD_TOKEN is required");
}

function legacyTokenFromPlist(plistPath) {
  validatePrivateFile(plistPath);
  const output = execFileSync(
    "/usr/bin/plutil",
    ["-extract", "ProgramArguments", "json", "-o", "-", plistPath],
    { encoding: "utf8", maxBuffer: 1024 * 1024 }
  );
  return legacyTokenFromArgs(JSON.parse(output));
}

function resolveDeviceAliases(options, { plistPath } = {}) {
  const explicit = parseDeviceAliases(options.deviceAlias);
  if (Object.keys(explicit).length > 0) return explicit;
  if (!plistPath && process.platform === "darwin") {
    plistPath = launchAgentPath();
  }
  if (!plistPath || !existsSync(plistPath)) return {};
  return installedDeviceAliasesFromPlist(plistPath);
}

function installedDeviceAliasesFromPlist(plistPath) {
  validatePrivateFile(plistPath);
  const output = execFileSync(
    "/usr/bin/plutil",
    ["-extract", "ProgramArguments", "json", "-o", "-", plistPath],
    { encoding: "utf8", maxBuffer: 1024 * 1024 }
  );
  return deviceAliasesFromArgs(JSON.parse(output));
}

function installedDeviceIdFromPlist(plistPath) {
  validatePrivateFile(plistPath);
  const output = execFileSync(
    "/usr/bin/plutil",
    ["-extract", "ProgramArguments", "json", "-o", "-", plistPath],
    { encoding: "utf8", maxBuffer: 1024 * 1024 }
  );
  return deviceIdFromArgs(JSON.parse(output));
}

function deviceAliasesFromArgs(args) {
  if (!Array.isArray(args)) return {};
  const values = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--device-alias" && typeof args[index + 1] === "string") {
      values.push(args[index + 1]);
      index++;
    }
  }
  return parseDeviceAliases(values);
}

function deviceIdFromArgs(args) {
  if (!Array.isArray(args)) return null;
  const index = args.indexOf("--device-id");
  if (index === -1 || typeof args[index + 1] !== "string") return null;
  return args[index + 1];
}

function legacyTokenFromArgs(args) {
  if (!Array.isArray(args)) return null;
  const index = args.indexOf("--token");
  if (index === -1 || typeof args[index + 1] !== "string") return null;
  return normalizeToken(args[index + 1]);
}

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sleep(ms, keepGoing) {
  return new Promise((resolveSleep) => {
    const step = 1000;
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += step;
      if (elapsed >= ms || (keepGoing && !keepGoing())) {
        clearInterval(timer);
        resolveSleep();
      }
    }, step);
  });
}

function readRecallMemories(dbPath, statusSet, limit, cursor = {}) {
  if (!existsSync(dbPath)) {
    throw new Error(`Recall DB not found: ${dbPath}`);
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    const columns = new Set(db.prepare("PRAGMA table_info(memories)").all().map((column) => column.name));
    const note = columns.has("note") ? ", note" : "";
    const placeholders = [...statusSet].map(() => "?").join(",");
    const cursorClause = cursor.after
      ? "AND (updated_at > ? OR (updated_at = ? AND id > ?))"
      : "";
    const params = [...statusSet];
    if (cursor.after) {
      params.push(cursor.after, cursor.after, cursor.afterId ?? "");
    }
    params.push(limit);
    return db.prepare(`
      SELECT
        id, type, text, scope, path_scope, repo, status, confidence, source,
        evidence, capture_context, supersedes, created_at, updated_at,
        last_validated_at, last_injected_at, injection_count, override_count,
        repetition_count, team_id, sync_version, auto_inject, dedupe_key${note}
      FROM memories
      WHERE status IN (${placeholders})
      ${cursorClause}
      ORDER BY updated_at ASC
      , id ASC
      LIMIT ?
    `).all(...params);
  } finally {
    db.close();
  }
}

function loadSyncState(statePath) {
  if (!existsSync(statePath)) return { version: 1, entries: {} };
  validatePrivateFile(statePath);
  try {
    const value = JSON.parse(readFileSync(statePath, "utf8"));
    if (
      value?.version === 1
      && value.entries
      && typeof value.entries === "object"
      && !Array.isArray(value.entries)
    ) {
      return value;
    }
  } catch {
    // Fail safe: a corrupt cursor causes one full reconciliation, not data loss.
  }
  return { version: 1, entries: {} };
}

function saveSyncState(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  writePrivateFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
  validatePrivateFile(statePath);
}

// The record's "source" for the cloud Sources page (privacy-toggle unit). Group
// by repo/project when known (e.g. "edihasaj/recall"); fall back to the local
// capture channel (e.g. "capture:user_correction"), else a generic "local"
// bucket. The cloud registers one source per distinct ref and attributes each
// memory to it (memory_records.source_id), which is what the Sources page lists.
function sourceRefFor(row) {
  const repo = row.repo ? String(row.repo).trim() : "";
  if (repo) return repo;
  const src = row.source ? String(row.source).trim() : "";
  if (src) return `capture:${src}`;
  return "local";
}

function toCloudRecord(row, deviceId, e2ee = null, deviceAliases = {}) {
  const recall = {
    type: row.type,
    ...(Object.hasOwn(row, "note") ? { note: typeof row.note === "string" ? row.note.replace(/\s+/g, " ").trim() || null : null } : {}),
    scope: row.scope,
    pathScope: row.path_scope,
    repo: row.repo,
    source: row.source,
    evidence: parseJson(row.evidence, []),
    captureContext: parseJson(row.capture_context, null),
    supersedes: row.supersedes,
    lastValidatedAt: row.last_validated_at,
    lastInjectedAt: row.last_injected_at,
    injectionCount: row.injection_count,
    overrideCount: row.override_count,
    repetitionCount: row.repetition_count,
    teamId: row.team_id,
    syncVersion: row.sync_version,
    autoInject: Boolean(row.auto_inject),
    dedupeKey: row.dedupe_key
  };

  const base = {
    externalId: cloudExternalIdForRow(row, deviceId, deviceAliases),
    status: normalizeStatus(row.status),
    kind: row.type,
    confidence: clampConfidence(row.confidence),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };

  if (e2ee) {
    // Zero-knowledge: encrypt BOTH the text and the rich metadata (evidence /
    // capture context carry plaintext), and omit the repo-based sourceId so the
    // server never learns which projects the memories came from. Only opaque
    // ciphertext + structural fields (kind/confidence/timestamps) are sent.
    const { ciphertext, nonce } = e2eeEncrypt(e2ee.key, JSON.stringify({ text: row.text, recall }));
    return {
      ...base,
      encryptionMode: "e2ee",
      contentCiphertext: ciphertext,
      contentNonce: nonce,
      contentKeyId: E2EE_KEY_ID,
      metadata: { e2ee: true, source: "recall-local-sqlite", localMemoryId: row.id, deviceId }
    };
  }

  return {
    ...base,
    sourceId: sourceRefFor(row),
    encryptionMode: "synced",
    contentPlaintext: row.text,
    metadata: { source: "recall-local-sqlite", localMemoryId: row.id, deviceId, recall }
  };
}

async function verifyRemoteEncryption(api, token, e2ee) {
  const remote = await fetchAllSyncRecords({ api, token, max: 100001 });
  if (remote.length > 100000) throw new Error("E2EE verification exceeded the safe record limit; sync was stopped.");
  for (const record of remote) {
    if (record.encryptionMode === "e2ee") decryptCloudPayload(record, e2ee, e2eeDecrypt);
  }
}

async function fetchAllSyncRecords({ api, token, since = null, sinceId = null, max = 100000 }) {
  const all = [];
  let cursorTime = since ?? null;
  let cursorId = sinceId ?? null;

  while (all.length < max) {
    const pageSize = Math.min(500, max - all.length);
    const result = await fetchJson(`${api}/v1/sync/pull`, {
      method: "POST",
      token,
      body: { since: cursorTime, sinceId: cursorId, limit: pageSize }
    });
    if (!Array.isArray(result.records)) throw new Error("Invalid Cloud sync response: records are missing");
    const batch = result.records;
    if (batch.length === 0) break;
    all.push(...batch);
    const last = batch[batch.length - 1];
    if (!last?.updatedAt || !last?.externalId) throw new Error("Invalid Cloud sync response: cursor is missing");
    if (batch.length < pageSize) break;
    if (last.updatedAt === cursorTime && last.externalId === cursorId) throw new Error("Invalid Cloud sync response: cursor did not advance");
    cursorTime = last.updatedAt;
    cursorId = last.externalId;
  }

  return all;
}

async function fetchJson(url, { method, token, body }) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(url, {
    method,
    headers,
    body: JSON.stringify(body ?? {})
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const parsed = text ? JSON.parse(text) : {};
      if (typeof parsed.error === "string") detail = parsed.error;
      else if (typeof parsed.detail === "string") detail = parsed.detail;
    } catch {
      // HTML proxy errors are intentionally not echoed into long-lived logs.
    }
    throw new Error(`${method} ${url} failed ${response.status}: ${detail}`);
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${method} ${url} returned invalid JSON response (${response.status})`);
  }
}

function normalizeStatus(status) {
  if (status === "active" || status === "candidate" || status === "rejected") return status;
  if (status === "transient") return "candidate";
  throw new Error(`Unsupported Recall status: ${status}`);
}

function clampConfidence(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = camelCase(arg.slice(2));
    if (
      key === "dryRun"
      || key === "json"
      || key === "quiet"
      || key === "e2ee"
      || key === "sample"
      || key === "tokenStdin"
      || key === "forceDeviceId"
    ) {
      options[key] = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    if (options[key] == null) {
      options[key] = value;
    } else if (Array.isArray(options[key])) {
      options[key].push(value);
    } else {
      options[key] = [options[key], value];
    }
    index++;
  }
  return options;
}

function parseDeviceAliases(value) {
  const aliases = {};
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  for (const entry of values) {
    const text = String(entry);
    const separator = text.indexOf("=");
    if (separator <= 0 || separator === text.length - 1) {
      throw new Error(`Invalid --device-alias value: ${text}`);
    }
    const from = text.slice(0, separator).trim();
    const to = text.slice(separator + 1).trim();
    if (!from || !to || from.includes(":") || to.includes(":")) {
      throw new Error(`Invalid --device-alias value: ${text}`);
    }
    aliases[from] = to;
  }
  return aliases;
}

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function required(value, flag) {
  if (!value) {
    throw new Error(`${flag} is required`);
  }
  return value;
}

function requiredApi(value) {
  return validateApiUrl(required(value, "--api"));
}

function parseInteger(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid integer: ${value}`);
  }
  return parsed;
}

export function parseNonNegativeInteger(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid integer: ${value}`);
  }
  return parsed;
}

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function hostnameLabel() {
  return process.env.RECALL_CLOUD_DEVICE_ID
    ?? process.env.HOSTNAME
    ?? hostname()
    ?? "local-device";
}

function usage() {
  console.log(`Usage:
  node scripts/recall-sync.mjs push --api <url> --token-file <0600-file> [--db ~/.recall/recall.db] [--status active,candidate] [--dry-run] [--sample]
  node scripts/recall-sync.mjs pull --api <url> --token-file <0600-file> [--db ~/.recall/recall.db] [--since <iso>] [--limit 100000] [--rejected-retention-days 90] [--dry-run]
  node scripts/recall-sync.mjs verify --api <url> --token-file <0600-file> [--query recall]
  node scripts/recall-sync.mjs memories --api <url> --token-file <0600-file> [--query <text>] [--device <id>] [--show 40] [--json]
  node scripts/recall-sync.mjs watch --api <url> --token-file <0600-file> [--interval 300] [--full-reconcile-interval 86400] [--status active,candidate] [--device-id <id>] [--device-alias old=new]
  printf '%s' "$RECALL_CLOUD_TOKEN" | node scripts/recall-sync.mjs install --api <url> --token-stdin [--interval 300] [--device-id <id>] [--device-alias old=new] [--force-device-id]
  node scripts/recall-sync.mjs uninstall                                                                  # remove launchd auto-sync

E2EE (zero-knowledge): add --e2ee (with --e2ee-passphrase <secret> or RECALL_CLOUD_E2EE_PASSPHRASE)
  to push/pull/watch to encrypt or decrypt content + metadata client-side; the server stores only
  ciphertext and cannot search/compile/profile those memories. Add --e2ee to 'memories' to decrypt
  and read them back locally. Use the SAME passphrase on every device. Tradeoff: e2ee memories are
  invisible to the web portal, hosted MCP, and server-side search.

Token sources: --token-file (preferred), --token-stdin (install/one-off), or RECALL_CLOUD_TOKEN.
The legacy --token flag remains compatible for one-off commands but exposes its value in process listings.
Env fallbacks: RECALL_CLOUD_API, RECALL_CLOUD_TOKEN, RECALL_DB, RECALL_CLOUD_DEVICE_ID, RECALL_CLOUD_E2EE_PASSPHRASE
Install refuses accidental device-id changes because local-origin records use it
in cloud external IDs; use --force-device-id only for an intentional migration.
Use --device-alias old=new during a migration so imported rows that still remember
old cloud origins are pushed under the canonical device id.
Dry-run push output is count-only by default; add --sample only when plaintext
record samples are intentionally needed for debugging.
`);
}
