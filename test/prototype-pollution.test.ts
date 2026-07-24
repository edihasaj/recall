import { describe, expect, it } from "vitest";
import { stripVolatileFields } from "../src/models/dedupe.js";
import { redactSensitiveValue } from "../src/security/redaction.js";

const malicious = () => JSON.parse(
  '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}',
) as Record<string, unknown>;

describe("prototype pollution defenses", () => {
  it("redacts recursive objects without changing their prototype", () => {
    const result = redactSensitiveValue(malicious()) as Record<string, unknown>;
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("strips volatile fields without changing the output prototype", () => {
    const input = malicious();
    input.timestamp = "drop";
    const result = stripVolatileFields(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.hasOwn(result, "timestamp")).toBe(false);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });
});
