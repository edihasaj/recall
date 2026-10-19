/**
 * Lossless UMP record persistence helpers.
 *
 * Recall's legacy memory table intentionally has a small, instruction-focused
 * shape. Direct UMP writes therefore keep their complete record in
 * `capture_context.ump_record`, while the normal columns remain useful to
 * Recall's existing FTS/vector indexes.
 */

import type { MemoryRecord } from "@universalmemoryprotocol/core";

export type StoredUmpRecord = MemoryRecord;

export function storedUmpRecord(value: unknown): StoredUmpRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<MemoryRecord>;
  if (
    record.ump !== "1.0" ||
    typeof record.id !== "string" ||
    typeof record.kind !== "string" ||
    !record.body ||
    typeof record.body.text !== "string" ||
    !record.scope ||
    typeof record.scope.owner !== "string" ||
    !record.time ||
    typeof record.time.created !== "string"
  ) {
    return undefined;
  }
  return record as StoredUmpRecord;
}

/**
 * Persisted IDs are native Recall UUIDs encoded through the SDK's UMP-ID
 * bridge. Changing an id invalidates a record signature, so L1 storage strips
 * integrity rather than retaining an invalid signature.
 */
export function canonicalizeStoredRecord(
  record: MemoryRecord,
  canonicalId: string,
  previous?: MemoryRecord,
): StoredUmpRecord {
  const validTo = earliestValidTo(previous?.time.valid_to, record.time.valid_to);

  return {
    ...record,
    id: canonicalId,
    time: {
      ...record.time,
      ...(validTo !== undefined ? { valid_to: validTo } : {}),
    },
    // A replacement closes a predecessor and adds its successor. Never lose
    // that history if an adapter sends a partial lifecycle rewrite.
    supersedes: unionStrings(previous?.supersedes, record.supersedes),
    superseded_by: unionStrings(previous?.superseded_by, record.superseded_by),
    // Relations are a full-record field. A revise may intentionally remove
    // one, so only lifecycle lineage is merged defensively above.
    relations: record.relations,
    integrity: undefined,
  };
}

function earliestValidTo(
  previous: string | null | undefined,
  incoming: string | null | undefined,
): string | null | undefined {
  if (previous == null) return incoming;
  if (incoming == null) return previous;
  const previousAt = Date.parse(previous);
  const incomingAt = Date.parse(incoming);
  if (Number.isNaN(previousAt) || Number.isNaN(incomingAt)) return previous;
  return previousAt <= incomingAt ? previous : incoming;
}

function unionStrings(
  left?: string[],
  right?: string[],
): string[] | undefined {
  const values = [...(left ?? []), ...(right ?? [])];
  return values.length ? [...new Set(values)] : undefined;
}

