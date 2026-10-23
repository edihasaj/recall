export type ReasoningEffort = "none" | "low" | "medium" | "high" | "adaptive";
export type NativeReasoningEffort = Exclude<ReasoningEffort, "adaptive">;

// Recognized English enumeration phrases only; this is not a semantic classifier.
const ENUMERATION = /\bhow\s+many\b|\bnumber\s+of\b|\btotal\s+count\b|(?:^|[.!?]\s*|\bplease\s+)count\b|\b(?:can|could|would|will)\s+you\s+(?:please\s+)?count\b/i;

/** Resolve from the standalone original question only. */
export function resolveReasoningEffort(
  requested: ReasoningEffort,
  question?: string,
): NativeReasoningEffort {
  if (requested !== "adaptive") return requested;
  if (!question) throw new Error("Adaptive reasoning requires original question metadata");
  return ENUMERATION.test(question) ? "high" : "low";
}
