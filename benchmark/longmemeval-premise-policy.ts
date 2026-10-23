/** Prospective benchmark-only premise check; it does not alter the original task or evidence. */
export const PREMISE_CHECK_POLICY = [
  "Before answering, identify the specific person, item, event, place or activity the question asks about.",
  "This check concerns only whether that subject exists in the excerpts. An omitted detail is not proof that an event did not happen, but a question about a specific subject still needs some excerpt mentioning that subject. If no excerpt mentions it at all, answer that the conversation history does not record it.",
  "Do not substitute a different subject: a similar item, another person, another category or another activity does not satisfy the question. In that case do not give a conditional answer such as 'if you meant X'; state that the asked-about subject is not recorded, optionally naming the closest recorded subject without presenting its value as the answer.",
  "When the subject is recorded, answer normally even if the evidence is indirect, partial or requires counting or combining excerpts. If its date, time window or identity is ambiguous, follow the history policy: give each supported interpretation and its condition instead of refusing.",
].join("\n");
