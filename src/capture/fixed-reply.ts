// Literal response contracts belong to the task that requested them. They are
// not durable preferences, even when a worker prompt says "always" or an
// extractor rewrites "Reply only ..." as "Use Reply only ... instead".
const RESPONSE_CLAUSE = /^(?:(?:please|just|use|always)\s+|(?:from now on|going forward)\s*,?\s*)*(?:reply|respond|answer|return|output|say|print)\s+(?:(?:with|using)\s+)?(?:(only|exactly|just)\s+(?:with\s+)?(.+)|(.+?)\s+only)$/i;
const FORMAT = /^(?:valid\s+)?(?:json|yaml|xml|csv|tsv|toml|markdown|plain\s+text|code)$/i;
const QUOTED = /^(?:"[^"\n]+"|'[^'\n]+'|`[^`\n]+`|“[^”\n]+”|‘[^’\n]+’)$/u;

export function isFixedReplyInstruction(text: string): boolean {
  if (!/\b(?:reply|respond|answer|return|output|say|print)\b/i.test(text)) return false;
  for (const clause of responseClauses(text)) {
    const match = RESPONSE_CLAUSE.exec(clause.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, ""));
    if (!match) continue;
    const payload = (match[2] ?? match[3]).replace(/\s+instead$/i, "").trim();
    const quoted = QUOTED.test(payload);
    const value = quoted ? payload.slice(1, -1).trim() : payload;
    // Preserve actual output-format and language preferences, rather than
    // rejecting every instruction containing "reply only".
    if (FORMAT.test(value) || /^(?:in|as)\s+/i.test(value)) continue;
    if (quoted || /^[A-Za-z0-9]+(?:[_:-][A-Za-z0-9]+)+$/.test(value)
      || /^(?:ok|yes|no|ready|done|pass|fail|pong)$/i.test(value)
      || match[1]?.toLowerCase() === "exactly") return true;
  }
  return false;
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
      const conjunction = /^\s+(?:and|then)\s+(?=(?:(?:please|just|use|always)\s+)*(?:reply|respond|answer|return|output|say|print)\b)/i.exec(text.slice(index, index + 100));
      if (conjunction) {
        clauses.push(text.slice(start, index));
        start = index + conjunction[0].length; index = start - 1;
      }
    }
  }
  clauses.push(text.slice(start));
  return clauses;
}
