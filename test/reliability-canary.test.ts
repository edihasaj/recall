import { afterEach, describe, expect, it } from "vitest";
import { runReliabilityCanary } from "../src/reliability/canary.js";

afterEach(() => { delete process.env.RECALL_EMBEDDINGS_DISABLED; });

describe("reliability canary", () => {
  it("proves capture-to-outcome flow without touching the real database", async () => {
    const result = await runReliabilityCanary();
    expect(result.ok).toBe(true);
    expect(result.real_embeddings).toBe(false);
    expect(result.checks).toMatchObject({
      selected_and_emitted: true,
      emission_coverage: true,
      outcome_observed: true,
      database_integrity: true,
    });
    expect(result.reliability.sessions).toBe(1);
  });
});
