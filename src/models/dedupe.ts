import { createHash } from "node:crypto";
import { defineOwn } from "../security/object.js";

export const ACTIVITY_DEDUPE_PREFIX = "activity\u001fsha256:";
export const HOOK_DEDUPE_PREFIX = "hook\u001fsha256:";

export function compactDedupeKey(
  namespace: "activity" | "hook",
  legacyKey: string,
): string {
  const prefix = namespace === "activity"
    ? ACTIVITY_DEDUPE_PREFIX
    : HOOK_DEDUPE_PREFIX;
  return `${prefix}${createHash("sha256").update(legacyKey).digest("hex")}`;
}

export function normalizeDedupeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.;:,!?`]+$/g, "")
    .trim();
}

export function memoryDedupeKey(input: {
  type: string;
  scope: string;
  repo?: string | null;
  path_scope?: string | null;
  text: string;
}): string {
  return [
    "memory",
    input.type,
    input.scope,
    input.repo ?? "",
    input.path_scope ?? "",
    normalizeDedupeText(input.text),
  ].join("\u001f");
}

export function historySnippetDedupeKey(input: {
  repo?: string | null;
  session_id?: string | null;
  kind: string;
  text: string;
}): string {
  return [
    "history",
    input.repo ?? "",
    input.session_id ?? "",
    input.kind,
    normalizeDedupeText(input.text),
  ].join("\u001f");
}

export function activityEventDedupeKey(input: {
  session_id?: string | null;
  repo?: string | null;
  path?: string | null;
  source: string;
  event_type: string;
  request?: Record<string, unknown>;
  result?: Record<string, unknown>;
}): string | null {
  if (!input.session_id) return null;
  const legacyKey = [
    "activity",
    input.session_id,
    input.repo ?? "",
    input.path ?? "",
    input.source,
    input.event_type,
    stableDedupeJson(stripVolatileFields(input.request ?? {})),
    stableDedupeJson(stripVolatileFields(input.result ?? {})),
  ].join("\u001f");
  return compactDedupeKey("activity", legacyKey);
}

export function hookCallDedupeKey(input: {
  session_id?: string | null;
  agent: string;
  event: string;
  ok: boolean;
  payload?: Record<string, unknown>;
}): string | null {
  if (!input.session_id) return null;
  const legacyKey = [
    "hook",
    input.session_id,
    input.agent,
    input.event,
    input.ok ? "ok" : "error",
    stableDedupeJson(stripVolatileFields(input.payload ?? {})),
  ].join("\u001f");
  return compactDedupeKey("hook", legacyKey);
}

export function stripVolatileFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripVolatileFields);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/_at$/u.test(key) || key === "timestamp") continue;
    if (entry === undefined) continue;
    defineOwn(out, key, stripVolatileFields(entry));
  }
  return out;
}

export function stableDedupeJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableDedupeJson).join(",")}]`;
  }
  if (!value || typeof value !== "object") {
    return JSON.stringify(value);
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableDedupeJson(record[key])}`
  )).join(",")}}`;
}
