const SYSTEM_SCAFFOLD_RE =
  /(?:^\s*[⏺⎿❯✻※]|<\/?task-notification>|task-notification|hook activity|\[correction_summary\]|correction_summary|session(?:start| start| end) hook|stop hook|<system-reminder>|<\/?command-(?:name|message)>|recent_tool_calls|probeport qa agent contract|you extract durable memory candidates for a personal agent runtime|required schema_version:\s*memory_extraction|##\s*(?:run context|scout assignment|lead verifier assignment|available tool commands|mapped local files|allowed secret environment names))/i;

const NON_USER_CONTEXT_RE =
  /\b(?:sub-?agent (?:context|transcript|output|notification)|(?:during|after) compaction|compaction (?:context|summary|transcript)|compacting (?:the )?(?:context|conversation)|system repair (?:context|transcript)|self[- ]repair context|repair context|cron context)\b/i;

const INJECTION_ARTIFACT_RE = new RegExp(
  [
    "ignore (?:all |any |the )?(?:previous|prior|above|earlier) (?:instructions|prompts?|messages?|rules?)",
    "disregard (?:all |any |the )?(?:previous|prior|above|earlier)\\b",
    "\\bexact reply\\b",
    "reply (?:with )?exactly\\b",
    "use (?:private|runtime|internal)(?:/[a-z]+)* state for this answer",
    "do not use tools\\b[^.]*\\b(?:answer|state|reply|instead)",
    "required generated files?\\b",
    "verify the generated (?:scorecard|artifact|output|file)",
    "must preserve the visible labels?\\b",
    "promised\\b[^.]*\\bactions\\b[^.]*\\bexecuted",
    "\\bACP actions\\b",
  ].join("|"),
  "i",
);

const EPHEMERAL_TASK_CONTEXT_RE =
  /(?:^\s*\/goal\b|pause for (?:the )?user\b|this is task def(?:inition)?:|key details\s+description\s+(?:goal|background)\b|link to jira ticket|what(?:'|’)s changed\?|this article lists the tools we use for development|required software on node)/i;

// Tool/review reports are often pasted after a short user request. Imperative
// sentences inside them describe the reporting agent's operating contract;
// they are not a preference the user is teaching Recall. Require several
// structural markers so an ordinary multiline user prompt is not quarantined.
const OPERATIONAL_REPORT_MARKERS: RegExp[] = [
  /(?:^|\n)\s*(?:✏️|❓|✅|❌)\s*(?:review|test|checkout)\s*:/iu,
  /\bTouch-map\s*:/i,
  /\b\d+\/\d+ gates passed\b/i,
  /\b(?:gates|checkout) skipped\b/i,
  /\bUsage Error\s*:/i,
  /\b(?:no provider review|verdict from gates only)\b/i,
  /\bLocal review only for this repo\b/i,
];

export function looksLikePastedOperationalReport(text: string): boolean {
  if (text.length < 500 || !text.includes("\n")) return false;
  const leadingRequest = text.split(/\r?\n\s*\r?\n/, 1)[0] ?? "";
  if (DURABLE_INTENT_MARKER_RE.test(leadingRequest)) return false;
  const markerCount = OPERATIONAL_REPORT_MARKERS.reduce(
    (count, marker) => count + (marker.test(text) ? 1 : 0),
    0,
  );
  return markerCount >= 2;
}

const DURABLE_INTENT_MARKER_RE =
  /\b(?:always|never|from now on|going forward|henceforth|every time|whenever|by default|make (?:this|it) a rule|remember this|save this|for this repo|for this project|repo-wide|project-wide|across (?:all )?(?:repos|projects)|globally|everywhere)\b/i;

const GENERIC_CHANGE_CONTROL_RE = new RegExp(
  [
    "(?:do\\s+not|don't|no)\\s+(?:commit|push)(?:\\s*(?:\\/|or|and)\\s*(?:commit|push))?(?:\\s+(?:any\\s+)?(?:changes?|work|anything|repository\\s+changes?|from\\s+this\\s+worktree))?",
    "without\\s+(?:committing|pushing)(?:\\s+or\\s+(?:committing|pushing))?",
  ].join("|"),
  "i",
);

function changeControlClauses(text: string): string[] {
  return text
    .split(/(?:\r?\n|[.!?;])+/)
    .map((clause) => clause.trim())
    .filter((clause) => /\b(?:commit|push|committing|pushing)\b/i.test(clause));
}

/**
 * Detect one-turn git authorization constraints such as "fix it; don't
 * commit/push". These instructions remain authoritative in the live prompt,
 * but are not durable memory unless the user adds an explicit persistence
 * marker ("never", "from now on", "for this repo", "remember this", …).
 * This is the conservative fallback for regex capture and legacy LLM results;
 * a current semantic durability judgment takes precedence.
 */
export function isEphemeralTaskConstraint(ruleText: string, rawPrompt: string): boolean {
  if (!GENERIC_CHANGE_CONTROL_RE.test(ruleText)) return false;
  // Object-specific safety rules are not generic authorization for the task.
  // "Do not commit secrets/.env/generated files" can be a durable repo rule.
  if (/\b(?:secret|credential|token|private key|\.env|config(?:uration)?|generated file|lockfile)s?\b/i.test(ruleText)) {
    return false;
  }
  const sourceClauses = changeControlClauses(rawPrompt);
  if (sourceClauses.length === 0) return false;
  const matchingClauses = sourceClauses.filter((clause) => GENERIC_CHANGE_CONTROL_RE.test(clause));
  if (matchingClauses.length === 0) return false;
  return matchingClauses.every((clause) => !DURABLE_INTENT_MARKER_RE.test(clause));
}

// Codex emits additional internal prompts through the same hook surface as
// genuine user turns. They are task-title, ambient-suggestion, and safety
// judge instructions owned by the harness, not durable preferences typed by
// the user. Exact family anchors keep the quarantine narrow while covering
// prompt revisions that retain the stable opening contract.
// LLM-worker system prompts share a stable contract shape regardless of which
// product owns the worker: a role header ("You are the <role> worker/judge for
// …") and a machine-output clause ("Return JSON only. No markdown. No prose.").
// They reach the hook surface whenever another pipeline runs its workers
// through a hooked CLI session; extracted "rules" from them poisoned the store
// as 0.99-confidence memories ("Compaction summaries must set schema_version
// to 'semantic_compaction'"). None of these shapes are durable user
// preferences, so quarantine the whole family.
const LLM_WORKER_PROMPT_RE =
  /(?:^\s*you are (?:the|an?)\s+[^\n]{0,80}?\b(?:worker|judge|extractor|summari[sz]er|compactor|classifier|grader|scorer|labeler)\b|\bfor a personal agent runtime\b|\breturn json only\b[^\n]{0,60}\bno (?:markdown|prose)\b)/i;

const CODEX_INTERNAL_PROMPT_RE =
  /(?:^\s*generate a title and a git branch name for a coding agent\b|^\s*#\s*overview\s+generate\s+0\s+to\s+3\s+hyperpersonalized suggestions for what this user can do with codex\b|^\s*you are an expert at upholding safety and compliance standards for codex ambient suggestions\b|^\s*you are the implementation worker for one isolated git worktree\b|^\s*you are reviewing github pull request\b[^\n]*\bon behalf of the maintainer\b|^\s*#\s*github issue workorder\s*:|^\s*continue the previous coding task using user-provided context only\b)/i;

function looksLikeQuestionContext(text: string): boolean {
  if (/\b(?:always|never|remember|memorize|save this|from now on|by default|make it a rule)\b/i.test(text)) {
    return false;
  }
  if (/^\s*(?:how|why|what|where|which|who)\b/i.test(text)) {
    return true;
  }
  if (/^\s*(?:can|could|should|would)\s+(?:i|we|you|they|it)\b/i.test(text)) {
    return true;
  }
  if (!text.includes("?")) return false;
  return (
    /\?\s*$/.test(text.trim()) ||
    /(?:^|[.!?]\s+)(?:how|why|what|where|which|who|can|could|should|would|do|does|did|is|are|was|were|have|has)\b/i.test(text)
  );
}

export function isNonUserCaptureContext(text: string): boolean {
  return (
    SYSTEM_SCAFFOLD_RE.test(text) ||
    NON_USER_CONTEXT_RE.test(text) ||
    INJECTION_ARTIFACT_RE.test(text) ||
    EPHEMERAL_TASK_CONTEXT_RE.test(text) ||
    looksLikePastedOperationalReport(text) ||
    LLM_WORKER_PROMPT_RE.test(text) ||
    CODEX_INTERNAL_PROMPT_RE.test(text) ||
    looksLikeQuestionContext(text)
  );
}
