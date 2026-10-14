/**
 * The text a memory is found by: its own text plus, when present, the note of
 * what it affects. The keyword index, the embedding and the re-ranker all read
 * this, so a memory can match a request that shares no words with its text
 * ("run the migration against staging" finding "staging has no replicas").
 *
 * The " Affects: " join matches the format the relevance models were trained
 * on; keep it stable, because the embedding content hash covers it.
 * Cloud-sync diagnostics may remain in a rejected memory's stored note after
 * reactivation, but their reserved segments must never become retrieval text.
 */
export function retrievalText(memory: { text: string; note?: string | null }): string {
  const note = normalizeNote(memory.note)
    ?.split(" | ")
    .map((segment) => segment.trim())
    .filter((segment) => segment && !segment.startsWith("cloud-dreaming:"))
    .join(" | ");
  return note ? `${memory.text} Affects: ${note}` : memory.text;
}

/** Trim a note and collapse it to one line; empty notes become null. */
export function normalizeNote(note: string | null | undefined): string | null {
  const flat = note?.replace(/\s+/g, " ").trim();
  return flat ? flat : null;
}
