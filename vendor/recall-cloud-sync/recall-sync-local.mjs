import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

export function cloudExternalIdForRow(row, deviceId, deviceAliases = {}) {
  const captureContext = parseJson(row.capture_context, null);
  const importedExternalId = captureContext
    && typeof captureContext === "object"
    && !Array.isArray(captureContext)
    && captureContext.recallCloudSync
    && typeof captureContext.recallCloudSync === "object"
    ? captureContext.recallCloudSync.externalId
    : null;
  return importedExternalId
    ? canonicalExternalId(String(importedExternalId), deviceAliases)
    : `${deviceId}:${row.id}`;
}

export function applyPulledRecords(
  dbPath,
  records,
  {
    deviceId,
    e2ee = null,
    decrypt = null,
    deviceAliases = {},
    rejectedRetentionDays = 90,
    now = Date.now()
  }
) {
  if (!existsSync(dbPath)) {
    throw new Error(`Recall DB not found: ${dbPath}`);
  }

  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  try {
    assertRecallSchema(db);
    const hasNote = db.prepare("PRAGMA table_info(memories)").all().some((column) => column.name === "note");
    const findById = db.prepare("SELECT * FROM memories WHERE id = ?");
    const findByDedupe = db.prepare(
      "SELECT * FROM memories WHERE dedupe_key = ? LIMIT 1"
    );
    const insert = db.prepare(`
      INSERT INTO memories (
        id, type, text, scope, path_scope, repo, status, confidence, source,
        evidence, capture_context, supersedes, created_at, updated_at,
        last_validated_at, last_injected_at, injection_count, override_count,
        repetition_count, team_id, sync_version, auto_inject, dedupe_key${hasNote ? ", note" : ""}
      ) VALUES (
        @id, @type, @text, @scope, @path_scope, @repo, @status, @confidence, @source,
        @evidence, @capture_context, @supersedes, @created_at, @updated_at,
        @last_validated_at, @last_injected_at, @injection_count, @override_count,
        @repetition_count, @team_id, @sync_version, @auto_inject, @dedupe_key${hasNote ? ", @note" : ""}
      )
    `);
    const update = db.prepare(`
      UPDATE memories SET
        type = @type,
        text = @text,
        scope = @scope,
        path_scope = @path_scope,
        repo = @repo,
        status = @status,
        confidence = @confidence,
        source = @source,
        evidence = @evidence,
        capture_context = @capture_context,
        supersedes = @supersedes,
        updated_at = @updated_at,
        last_validated_at = @last_validated_at,
        last_injected_at = @last_injected_at,
        injection_count = @injection_count,
        override_count = @override_count,
        repetition_count = @repetition_count,
        team_id = @team_id,
        auto_inject = @auto_inject,
        dedupe_key = @dedupe_key${hasNote ? ", note = @note" : ""}
      WHERE id = @id
    `);
    const stats = {
      imported: 0,
      updated: 0,
      unchanged: 0,
      skippedEncrypted: 0,
      skippedDuplicate: 0,
      skippedExpiredTombstone: 0
    };

    const apply = db.transaction(() => {
      for (const record of records) {
        const local = cloudRecordToLocalRow(record, { deviceId, e2ee, decrypt, deviceAliases });
        if (!local) {
          stats.skippedEncrypted++;
          continue;
        }

        // Quarantine foreign promotions: a record captured on another device
        // arrives here as candidate at most. Local gates (repetition, verify,
        // explicit confirm) are the only paths to active on this device —
        // trusting a remote 'active' imported 0.99-confidence LLM-worker
        // prompt extractions straight into the injection set, with no audit.
        const isForeign = Boolean(parseJson(local.capture_context, null)?.recallCloudSync);
        const quarantined = isForeign && local.status === "active";
        if (quarantined) local.status = "candidate";
        // The no-demote/merge guards below may reinstate "active"; the audit
        // reason must describe what actually happened, so it is finalized at
        // write time via auditReason(), not here.
        const baseReason = `pull:${canonicalExternalId(String(record.externalId), deviceAliases)}`;
        const auditReason = (finalStatus) => {
          if (!quarantined) return baseReason;
          return finalStatus === "candidate"
            ? `${baseReason} quarantined:active->candidate`
            : `${baseReason} quarantine-reinstated:local-active`;
        };

        const existing = findById.get(local.id);
        if (!hasNote) local.note = null;
        else if (!local.note_present) local.note = existing?.note ?? null;
        if (!existing) {
          // Recall intentionally removes rejected rows after local retention.
          // Keep applying old tombstones to rows that still exist, but do not
          // recreate a missing expired row on every full cloud reconciliation.
          if (isExpiredRejectedTombstone(local, rejectedRetentionDays, now)) {
            stats.skippedExpiredTombstone++;
            continue;
          }
          const duplicate = local.dedupe_key
            ? findByDedupe.get(local.dedupe_key)
            : null;
          if (duplicate) {
            if (preferDuplicateQuality(local, duplicate)) {
              const merged = {
                ...local,
                id: duplicate.id,
                created_at: duplicate.created_at,
                capture_context: duplicate.capture_context
              };
              if (hasNote && !local.note_present) merged.note = duplicate.note ?? null;
              if (duplicate.status === "active" && merged.status === "candidate") {
                merged.status = "active";
              }
              update.run(merged);
              syncLocalSearchIndexes(db, merged, duplicate.text !== merged.text || (duplicate.note ?? null) !== merged.note);
              recordSyncAudit(db, "edited", merged, duplicate, auditReason(merged.status));
              stats.updated++;
            } else {
              stats.skippedDuplicate++;
            }
            continue;
          }
          insert.run(local);
          syncLocalSearchIndexes(db, local, true);
          recordSyncAudit(db, "created", local, null, auditReason(local.status));
          stats.imported++;
          continue;
        }

        if (!isRemoteNewer(local.updated_at, existing.updated_at)) {
          stats.unchanged++;
          continue;
        }

        // A pull never demotes a locally-promoted active back to candidate;
        // rejection (an explicit user decision on any device) still applies.
        if (existing.status === "active" && local.status === "candidate") {
          local.status = "active";
        }

        if (
          local.dedupe_key
          && local.dedupe_key !== existing.dedupe_key
          && findByDedupe.get(local.dedupe_key)
        ) {
          local.dedupe_key = null;
        }
        update.run(local);
        syncLocalSearchIndexes(db, local, existing.text !== local.text || (existing.note ?? null) !== local.note);
        recordSyncAudit(db, "edited", local, existing, auditReason(local.status));
        stats.updated++;
      }
    });
    apply();
    return stats;
  } finally {
    db.close();
  }
}

function isExpiredRejectedTombstone(row, retentionDays, now) {
  if (row.status !== "rejected") return false;
  const updatedMs = Date.parse(String(row.updated_at));
  if (!Number.isFinite(updatedMs)) return false;
  return updatedMs < now - retentionDays * 86_400_000;
}

function cloudRecordToLocalRow(record, { deviceId, e2ee, decrypt, deviceAliases }) {
  let text = record.contentPlaintext;
  let metadata = record.metadata && typeof record.metadata === "object" ? record.metadata : {};
  if (record.encryptionMode === "e2ee") {
    if (!e2ee || !decrypt || !record.contentCiphertext || !record.contentNonce) return null;
    try {
      const payload = JSON.parse(
        decrypt(e2ee.key, record.contentCiphertext, record.contentNonce)
      );
      text = payload.text;
      metadata = { ...metadata, recall: payload.recall };
    } catch {
      return null;
    }
  }
  if (typeof text !== "string" || !text.trim()) return null;

  const recall = metadata.recall && typeof metadata.recall === "object" ? metadata.recall : {};
  const localMemoryId = typeof metadata.localMemoryId === "string" && metadata.localMemoryId
    ? metadata.localMemoryId
    : `cloud-${createHash("sha256").update(String(record.externalId)).digest("hex").slice(0, 32)}`;
  const captureContext = recall.captureContext
    && typeof recall.captureContext === "object"
    && !Array.isArray(recall.captureContext)
    ? { ...recall.captureContext }
    : {};
  const externalId = canonicalExternalId(String(record.externalId), deviceAliases);
  const metadataDeviceId = canonicalDeviceId(metadata.deviceId ?? null, deviceAliases);
  const isOwnRecord = externalId === `${deviceId}:${localMemoryId}`;
  if (!isOwnRecord) {
    captureContext.recallCloudSync = {
      externalId,
      deviceId: metadataDeviceId
    };
  }

  const status = record.status === "deleted" ? "rejected" : normalizeStatus(record.status);
  const updatedAt = String(record.updatedAt ?? new Date().toISOString());
  return {
    id: localMemoryId,
    type: String(recall.type ?? record.kind ?? "decision"),
    text,
    note: typeof recall.note === "string" ? recall.note.replace(/\s+/g, " ").trim() || null : null,
    note_present: Object.hasOwn(recall, "note") ? 1 : 0,
    scope: String(recall.scope ?? (recall.repo ? "repo" : "global")),
    path_scope: nullableString(recall.pathScope),
    repo: nullableString(recall.repo),
    status,
    confidence: clampConfidence(record.confidence),
    source: String(recall.source ?? metadata.source ?? "cloud_sync"),
    evidence: JSON.stringify(Array.isArray(recall.evidence) ? recall.evidence : []),
    capture_context: Object.keys(captureContext).length ? JSON.stringify(captureContext) : null,
    supersedes: nullableString(recall.supersedes),
    created_at: String(record.createdAt ?? updatedAt),
    updated_at: updatedAt,
    last_validated_at: nullableString(recall.lastValidatedAt),
    last_injected_at: nullableString(recall.lastInjectedAt),
    injection_count: safeInteger(recall.injectionCount),
    override_count: safeInteger(recall.overrideCount),
    repetition_count: safeInteger(recall.repetitionCount),
    team_id: nullableString(recall.teamId),
    sync_version: safeInteger(recall.syncVersion),
    auto_inject: recall.autoInject === false ? 0 : 1,
    dedupe_key: nullableString(recall.dedupeKey)
  };
}

export function canonicalExternalId(externalId, deviceAliases = {}) {
  const value = String(externalId);
  const index = value.indexOf(":");
  if (index === -1) return value;
  const prefix = value.slice(0, index);
  return `${canonicalDeviceId(prefix, deviceAliases)}${value.slice(index)}`;
}

function canonicalDeviceId(deviceId, deviceAliases = {}) {
  if (deviceId == null) return null;
  const value = String(deviceId);
  return Object.prototype.hasOwnProperty.call(deviceAliases, value)
    ? String(deviceAliases[value])
    : value;
}

function assertRecallSchema(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(memories)").all().map((row) => row.name));
  for (const requiredColumn of ["id", "type", "text", "status", "updated_at", "dedupe_key"]) {
    if (!columns.has(requiredColumn)) {
      throw new Error(`Recall DB schema is incompatible: memories.${requiredColumn} is missing`);
    }
  }
}

function syncLocalSearchIndexes(db, row, textChanged) {
  if (tableExists(db, "fts_memory_index")) {
    db.prepare("DELETE FROM fts_memory_index WHERE memory_id = ?").run(row.id);
    if (row.status !== "rejected" && row.status !== "transient") {
      db.prepare(`
        INSERT INTO fts_memory_index (
          memory_id, text, repo, status, type, scope, path_scope
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id,
        row.note ? `${row.text} Affects: ${row.note}` : row.text,
        row.repo ?? "",
        row.status,
        row.type,
        row.scope,
        row.path_scope ?? ""
      );
    }
  }
  if (textChanged && tableExists(db, "memory_embeddings")) {
    db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(row.id);
  }
}

// Pull writes previously left no trace in audit_trail, so imported memories
// were unexplainable after the fact. Best-effort: skipped when the local DB
// predates the audit_trail table.
function recordSyncAudit(db, action, after, before, reason) {
  if (!tableExists(db, "audit_trail")) return;
  db.prepare(`
    INSERT INTO audit_trail (
      id, memory_id, action, actor, before_snapshot, after_snapshot, reason, timestamp
    ) VALUES (?, ?, ?, 'cloud-sync', ?, ?, ?, ?)
  `).run(
    randomUUID(),
    after.id,
    action,
    before ? JSON.stringify(before) : null,
    JSON.stringify(after),
    reason,
    new Date().toISOString()
  );
}

function tableExists(db, name) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  );
}

function isRemoteNewer(remote, local) {
  const remoteMs = Date.parse(String(remote));
  const localMs = Date.parse(String(local));
  if (Number.isFinite(remoteMs) && Number.isFinite(localMs)) return remoteMs > localMs;
  return String(remote) > String(local);
}

function preferDuplicateQuality(remote, local) {
  const remoteQuality = [
    statusRank(remote.status),
    Number(remote.auto_inject === 1),
    Number(remote.confidence ?? 0),
    safeInteger(remote.injection_count),
    Date.parse(String(remote.updated_at)) || 0
  ];
  const localQuality = [
    statusRank(local.status),
    Number(local.auto_inject === 1),
    Number(local.confidence ?? 0),
    safeInteger(local.injection_count),
    Date.parse(String(local.updated_at)) || 0
  ];
  for (let index = 0; index < remoteQuality.length; index++) {
    if (remoteQuality[index] !== localQuality[index]) {
      return remoteQuality[index] > localQuality[index];
    }
  }
  return false;
}

function statusRank(status) {
  if (status === "active") return 3;
  if (status === "candidate") return 2;
  return 1;
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

function nullableString(value) {
  return value == null || value === "" ? null : String(value);
}

function safeInteger(value) {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
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
