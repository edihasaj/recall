/**
 * The text a memory is found by: its own text plus, when present, the note of
 * what it affects. The keyword index, the embedding and the re-ranker all read
 * this, so a memory can match a request that shares no words with its text
 * ("run the migration against staging" finding "staging has no replicas").
 *
 * The " Affects: " join matches the format the relevance models were trained
 * on; keep it stable, because the embedding content hash covers it.
 */
export function retrievalText(memory: { text: string; note?: string | null }): string {
  const note = normalizeNote(memory.note);
  return note ? `${memory.text} Affects: ${note}` : memory.text;
}

/** Trim a note and collapse it to one line; empty notes become null. */
export function normalizeNote(note: string | null | undefined): string | null {
  const flat = note?.replace(/\s+/g, " ").trim();
  return flat ? flat : null;
}
