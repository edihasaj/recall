import { resolveReasoningEffort } from "./longmemeval-inference-policy.js";

// Narrow English heuristics over the original question text only; not a semantic classifier.
// Only forms that ask for a new recommendation; past-tense recall ("did you recommend") is excluded.
const RECOMMENDATION_REQUEST = new RegExp([
  String.raw`(?:^|[.;,!?]\s*)(?:any|got\s+any|(?:do\s+you\s+)?have\s+any)\s+(?:recommendations?|suggestions?|advice|tips)\b`,
  String.raw`\b(?:i\s+(?:need|want)|looking\s+for)\s+(?:a\s+|some\s+)?(?:recommendations?|suggestions?|advice|tips)\b`,
  String.raw`\b(?:(?:can|could|would|will|do)\s+you\s+(?:please\s+)?|please\s+)(?:recommend|suggest|advise)\b`,
  String.raw`(?:^|[.;,!?]\s*)(?:recommend|suggest)\s+(?:a|an|some|me)\b`,
  String.raw`\bwhat\s+should\s+i\b|\bhelp\s+me\s+(?:choose|pick|decide)\b`,
].join("|"), "i");

const TEMPORAL_DEDUCTION = new RegExp([
  String.raw`\bwhat\s+order\b|\border\s+(?:of|in\s+which)\b|\bchronolog`,
  String.raw`\b(?:earliest|latest|most\s+recent(?:ly)?)\b`,
  String.raw`\b(?:came|happened|occurred|started|ended)\s+(?:first|last|before|after)\b`,
  String.raw`\bwhich\b[^?.]*\b(?:first|last|earlier|later|before|after)\b`,
  String.raw`\b(?:before\s+or\s+after|earlier\s+than|later\s+than)\b`,
  String.raw`\b(?:did|was|were|have|had)\s+i\b[^?.]*\b(?:before|after)\b`,
  String.raw`\bhow\s+(?:long|much\s+time)\b|\b(?:days|weeks|months|years)\s+between\b`,
].join("|"), "i");

/** Keep the adaptive enumeration route; add high effort only for explicit temporal deduction. */
export function resolveTemporalReasoningEffort(question: string): "low" | "high" {
  if (resolveReasoningEffort("adaptive", question) === "high") return "high";
  if (RECOMMENDATION_REQUEST.test(question)) return "low";
  return TEMPORAL_DEDUCTION.test(question) ? "high" : "low";
}
