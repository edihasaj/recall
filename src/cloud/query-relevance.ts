import { matchTokens, textMatchScore } from "../text/match.js";

const QUESTION_OPENERS = new Set(["how", "what", "which", "when", "where", "why", "can", "could", "should", "would", "please", "tell", "do", "does", "is", "are"]);
const CAPITALIZED_PHRASE = /\b[A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*)*\b/g;

/** Conservative retrieval gates, never a claim that the source answers a question. */
export function cloudRecordIsRelevant(query: string, text: string, semanticScore?: unknown): boolean {
  if (textMatchScore(query, text).score >= 0.45) return true;
  if (typeof semanticScore !== "number" || !Number.isFinite(semanticScore) || semanticScore > 1) return false;
  // Cosine scores near 0.8 are common even for unrelated E5 results. A weaker
  // match must share an explicit named subject; generic overlap such as
  // "home" or "project" cannot establish relevance by itself.
  if (semanticScore >= 0.9) return true;
  if (semanticScore < 0.8) return false;
  // The question must identify the name too. Source sentence capitalization
  // alone ("Home automation..." or "How to release...") proves nothing.
  const queryTerms = new Set((query.match(CAPITALIZED_PHRASE) ?? [])
    .flatMap((phrase) => matchTokens(phrase))
    .filter((token) => token !== "not" && !QUESTION_OPENERS.has(token)));
  const namedTerms = text.match(CAPITALIZED_PHRASE) ?? [];
  return namedTerms.some((term) => {
    const tokens = matchTokens(term).filter((token) => token !== "not");
    // A partial name such as "home" must not match "Google Home".
    return tokens.length > 0 && tokens.every((token) => queryTerms.has(token));
  });
}
