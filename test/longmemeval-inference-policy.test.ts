import { describe, expect, it } from "vitest";
import { resolveReasoningEffort } from "../benchmark/longmemeval-inference-policy.js";

describe("LongMemEval adaptive inference policy", () => {
  it("uses high reasoning only for generic enumeration questions", () => {
    expect(resolveReasoningEffort("adaptive", "How many books are on the shelf?")).toBe("high");
    expect(resolveReasoningEffort("adaptive", "Please count the completed tasks.")).toBe("high");
    expect(resolveReasoningEffort("adaptive", "Can you count the completed tasks?")).toBe("high");
    expect(resolveReasoningEffort("adaptive", "Could you count the items?")).toBe("high");
    expect(resolveReasoningEffort("adaptive", "What book should I read next?")).toBe("low");
  });

  it("requires question metadata only for adaptive mode", () => {
    expect(() => resolveReasoningEffort("adaptive")).toThrow("original question");
    expect(resolveReasoningEffort("high")).toBe("high");
  });
});
