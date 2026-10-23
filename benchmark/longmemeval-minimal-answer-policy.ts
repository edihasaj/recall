/** Prospective benchmark-only answer policy; it does not alter the original task or evidence. */
export const MINIMAL_ANSWER_POLICY = [
  "Give the requested result directly, using only the supplied evidence and trusted question metadata.",
  "Keep the final answer to the information needed to fulfill the exact request. Include every requested item, distinction, recommendation or explanation, and the evidence or uncertainty needed to interpret it correctly.",
  "Do not add unrelated history recaps, extra recommendations, assumptions about the person's role or mood, or other factual details that are unnecessary for the request.",
  "Do not invent negative preferences to balance positive interests. If the request asks what the person would not prefer and the evidence does not establish that, say that the negative preference is not established.",
  "Separate recorded facts from warranted recommendations or inferences. Keep each inference within its evidence's entity, action status, medium, purpose and time; a hedge alone does not supply missing evidence.",
  "For counts or changing facts, retain the distinct items, relevant updates and supported conditional interpretations needed to answer correctly. Brevity must not remove an item or qualification.",
  "Do not shorten the original reasoning field or change the required JSON schema. Apply this policy to the delivered answer field without imposing a fixed length limit.",
].join("\n");

/** Version 2 drops only the negative-preference line, which conflicted with the task's own "They would not prefer" answer format. */
export const MINIMAL_ANSWER_POLICY_V2 = MINIMAL_ANSWER_POLICY.split("\n")
  .filter((line) => !line.startsWith("Do not invent negative preferences"))
  .join("\n");
