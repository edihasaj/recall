import { createHash } from "node:crypto";

export type QuestionSource = { id: string; date: string; text: string };

/** Fingerprints the full ordered question source, independent of ranking shape. */
export function questionSourcesHash(question: string, sessions: readonly QuestionSource[]): string {
  const value = JSON.stringify([question, sessions.map((session) => [session.id, session.date, session.text])]);
  return createHash("sha256").update(value, "utf16le").digest("hex");
}
