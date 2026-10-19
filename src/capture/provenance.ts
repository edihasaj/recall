import type { MemoryItem } from "../types.js";

// These are transport envelopes, not natural-language intent heuristics.
// A generated message arriving on a user-prompt hook is still generated.
export function isGeneratedCaptureContext(text: string): boolean {
  return /^\s*<(?:system|developer|paseo-system|agent-response|task-notification|system-reminder)(?:\s|>)/i.test(text)
    || /^\s*\[(?:system|developer|tool result)\]/i.test(text)
    || /^\s*generate a title and a git branch name for a coding agent\b/i.test(text)
    || (/^\s*(?:classify|analy[sz]e|extract|score|summari[sz]e|generate|you are)\b/i.test(text)
      && /\b(?:return|output|respond)[^\n]{0,45}\bJSON\b/i.test(text)
      && (/"(?:expected_schema_version|schema_version|source_text|raw_prompt)"\s*:/.test(text)
        || /(?:^|\n)Routes:\s*\n/.test(text)));
}

export function containsGeneratedHistory(text: string): boolean {
  return text.split("\n").some((line) => isGeneratedCaptureContext(
    line.replace(/^\s*(?:[-*]\s*)?(?:\(\d+\)\s*)?/, ""),
  )) || isGeneratedCaptureContext(text);
}

export function isTaskLimitedRule(text: string): boolean {
  return /^\s*(?:for|during) (?:this|the current) (?:repository )?(?:review|task|turn|session)\b/i.test(text);
}

export function hasNonDurableProvenance(memory: MemoryItem): boolean {
  return isUmpSourceRecord(memory)
    || hasOnlyGeneratedEvidence(memory)
    || isTaskLimitedRule(memory.text);
}

/**
 * Faithful UMP writes are source assertions for the UMP query surface. They
 * are not ordinary Recall instructions, even when their native status is
 * active. A present record marker is fail-closed: an interrupted or corrupted
 * direct write must not become an ordinary instruction just because the
 * record can no longer be decoded. `ump_kind` alone remains legacy metadata.
 */
export function isUmpSourceRecord(memory: MemoryItem): boolean {
  const context = memory.capture_context;
  return context != null && Object.prototype.hasOwnProperty.call(context, "ump_record");
}

export function hasOnlyGeneratedEvidence(memory: MemoryItem): boolean {
  const contexts = memory.evidence
    .filter((entry) => entry.type === "session_correction" || entry.type === "review_feedback")
    .map((entry) => entry.context?.trim())
    .filter((context): context is string => Boolean(context));
  return contexts.length > 0 && contexts.every(isGeneratedCaptureContext);
}

export function hasDirectCorrectionEvidence(memory: MemoryItem): boolean {
  return memory.source === "user_correction" && memory.evidence.some((entry) =>
    entry.type === "session_correction"
    && Boolean(entry.context?.trim())
    && !isGeneratedCaptureContext(entry.context ?? ""),
  );
}
