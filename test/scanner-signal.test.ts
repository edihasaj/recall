import { describe, it, expect } from "vitest";
import { evaluateScannedMemory, isGenericScannedToolingMemory } from "../src/scanner/signal.js";

function evalCmd(text: string, confidence = 0.6) {
  return evaluateScannedMemory({ text, type: "command", source: "config_parse", confidence });
}

describe("scanner signal — generic Makefile targets", () => {
  it("rejects Makefile lines that only list standard lifecycle targets", () => {
    for (const text of [
      "Makefile targets: `make test`, `make clean`, `make setup`",
      "Makefile targets: `make build`, `make install`, `make test`, `make clean`",
      "Makefile targets: `make install`, `make test`, `make lint`, `make deploy`",
    ]) {
      const result = evalCmd(text);
      expect(result.action, text).toBe("reject");
      expect(result.reason).toBe("generic_tooling");
      expect(isGenericScannedToolingMemory({ text, type: "command", source: "config_parse" })).toBe(true);
    }
  });

  it("keeps Makefile lines that name a custom target, as a candidate (not active)", () => {
    const text = "Makefile targets: `make migrate`, `make seed-db`";
    const result = evalCmd(text, 0.9);
    expect(result.action).toBe("keep");
    // Not boosted to active-command confidence; stays below ACTIVE_MIN.
    expect(result.confidence).toBeLessThan(0.75);
    expect(isGenericScannedToolingMemory({ text, type: "command", source: "config_parse" })).toBe(false);
  });

  it("still rejects generic package scripts and keeps real package-manager choices", () => {
    expect(evalCmd("build: `npm run build`").action).toBe("reject");
    expect(evalCmd("typecheck: `tsc --noEmit`").action).toBe("reject");

    const pm = evalCmd("Use pnpm as the package manager", 0.62);
    expect(pm.action).toBe("keep");
    expect(pm.confidence).toBeGreaterThanOrEqual(0.62);
  });
});
