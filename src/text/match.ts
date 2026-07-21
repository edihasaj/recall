const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "call",
  "do",
  "for",
  "from",
  "i",
  "in",
  "import",
  "instead",
  "is",
  "it",
  "its",
  "just",
  "of",
  "on",
  "only",
  "or",
  "our",
  "please",
  "run",
  "that",
  "the",
  "this",
  "to",
  "use",
  "we",
  "with",
  "you",
  "your",
]);

const NEGATION_WORDS = new Set([
  "avoid",
  "dont",
  "forbid",
  "forbidden",
  "never",
  "no",
  "not",
  "stop",
]);

export interface TextMatchScore {
  score: number;
  jaccard: number;
  containment: number;
  intersection: number;
  left_tokens: string[];
  right_tokens: string[];
}

export function textMatches(left: string, right: string, threshold: number): boolean {
  return textMatchScore(left, right).score >= threshold;
}

export function textMatchScore(left: string, right: string): TextMatchScore {
  const leftTokens = matchTokens(left);
  const rightTokens = matchTokens(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return {
      score: 0,
      jaccard: 0,
      containment: 0,
      intersection: 0,
      left_tokens: leftTokens,
      right_tokens: rightTokens,
    };
  }

  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  const intersection = [...leftSet].filter((token) => rightSet.has(token)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  const jaccard = union === 0 ? 0 : intersection / union;
  const smaller = Math.min(leftSet.size, rightSet.size);
  const containment = smaller === 0 ? 0 : intersection / smaller;
  const containmentWeight = smaller < 2 ? 0 : smaller === 2 ? 0.75 : 0.9;
  const score = Math.max(jaccard, containment * containmentWeight);

  return {
    score,
    jaccard,
    containment,
    intersection,
    left_tokens: [...leftSet],
    right_tokens: [...rightSet],
  };
}

export function matchTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\bdo\s+not\b/g, " not ")
    .replace(/\bdon['’]?t\b/g, " dont ")
    .split(/[^a-z0-9]+/)
    .map(normalizeToken)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function normalizeToken(token: string): string {
  if (NEGATION_WORDS.has(token)) return "not";
  if (/^es\d+$/.test(token)) return "es";
  if (token === "ran" || token === "running" || token === "runs") return "run";
  if (token === "using" || token === "used" || token === "uses") return "use";
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ing") && token.length > 5) return token.slice(0, -3);
  if (token.endsWith("ed") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("s") && token.length > 3) return token.slice(0, -1);
  return token;
}
