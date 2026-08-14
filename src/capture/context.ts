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

// Codex emits additional internal prompts through the same hook surface as
// genuine user turns. They are task-title, ambient-suggestion, and safety
// judge instructions owned by the harness, not durable preferences typed by
// the user. Exact family anchors keep the quarantine narrow while covering
// prompt revisions that retain the stable opening contract.
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
    CODEX_INTERNAL_PROMPT_RE.test(text) ||
    looksLikeQuestionContext(text)
  );
}
