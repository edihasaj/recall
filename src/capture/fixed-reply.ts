// Literal response contracts belong to the task that requested them. They are
// not durable preferences, even when a worker prompt says "always" or an
// extractor rewrites "Reply only ..." as "Use Reply only ... instead".
const PREFIX = /^(?:please|just|use|always|from now on|going forward)\s+/i;
const RESPONSE_VERB = /^(?:reply|respond|answer|return|output|say|print)\s+/i;
const FORMAT = /^(?:valid\s+)?(?:json|yaml|xml|csv|tsv|toml|markdown|plain\s+text|code)$/i;
const QUOTED = /^(?:"[^"\n]+"|'[^'\n]+'|`[^`\n]+`|“[^”\n]+”|‘[^’\n]+’)$/u;

export function isFixedReplyInstruction(text: string): boolean {
  if (!/\b(?:reply|respond|answer|return|output|say|print)\b/i.test(text)) return false;
  for (const clause of responseClauses(text)) {
    const parsed = parseResponseClause(clause);
    if (!parsed) continue;
    const payload = (withoutLastWord(parsed.payload, "instead") ?? parsed.payload).trim();
    const quoted = QUOTED.test(payload);
    const value = quoted ? payload.slice(1, -1).trim() : payload;
    // Preserve actual output-format and language preferences, rather than
    // rejecting every instruction containing "reply only".
    if (FORMAT.test(value) || /^(?:in|as)\s+/i.test(value)) continue;
    if (quoted || /^[A-Za-z0-9]+(?:[_:-][A-Za-z0-9]+)+$/.test(value)
      || /^(?:ok|yes|no|ready|done|pass|fail|pong)$/i.test(value)
      || parsed.exactly) return true;
  }
  return false;
}

function withoutLastWord(text: string, word: string): string | undefined {
  const value = text.trimEnd(); const boundary = value.length - word.length;
  if (boundary < 1 || value.slice(boundary).toLowerCase() !== word || !/\s/.test(value[boundary - 1])) return;
  return value.slice(0, boundary).trimEnd();
}

function parseResponseClause(clause: string): { payload: string; exactly: boolean } | undefined {
  let value = clause.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, "");
  // Consume at most eight explicit prefixes instead of a nested repeating
  // regex. Adversarial repetitions must not trigger exponential backtracking.
  for (let count = 0; count < 8; count++) {
    const prefix = PREFIX.exec(value);
    if (!prefix) break;
    value = value.slice(prefix[0].length);
  }
  const verb = RESPONSE_VERB.exec(value); if (!verb) return;
  value = value.slice(verb[0].length).replace(/^(?:with|using)\s+/i, "");
  const qualifier = /^(only|exactly|just)\s+/i.exec(value);
  if (qualifier) return { payload: value.slice(qualifier[0].length).replace(/^with\s+/i, ""), exactly: qualifier[1].toLowerCase() === "exactly" };
  const payload = withoutLastWord(value, "only");
  if (payload) return { payload, exactly: false };
}

function responseClauses(text: string): string[] {
  const clauses: string[] = [];
  const closing: Record<string, string> = { '"': '"', "'": "'", '`': '`', '“': '”', '‘': '’' };
  let quote: string | undefined; let start = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      if (character === quote && text[index - 1] !== "\\") quote = undefined;
    } else if (closing[character] && (index === 0 || !/[\p{L}\p{N}]/u.test(text[index - 1]))) {
      quote = closing[character];
    } else if (/[.!?;,\r\n]/.test(character)) {
      clauses.push(text.slice(start, index)); start = index + 1;
    } else if (/\s/.test(character)) {
      const ahead = text.slice(index, index + 100);
      const conjunction = /^\s+(?:and|then)\s+/i.exec(ahead);
      if (conjunction && parseResponseClause(ahead.slice(conjunction[0].length))) {
        clauses.push(text.slice(start, index));
        start = index + conjunction[0].length; index = start - 1;
      }
    }
  }
  clauses.push(text.slice(start));
  return clauses;
}
