import { describe, expect, it } from "vitest";
import { normalizeQueryForRetrieval } from "../src/compiler/context.js";

describe("normalizeQueryForRetrieval", () => {
  it("strips harness wrapper tags", () => {
    const input = `
      <task-notification>
        <task-id>abc-123</task-id>
        <status>queued</status>
      </task-notification>
      <system-reminder>The task tools haven't been used recently.</system-reminder>
      should I use npm or pnpm here?
    `;
    const out = normalizeQueryForRetrieval(input);
    expect(out).not.toMatch(/<task-notification/);
    expect(out).not.toMatch(/<system-reminder/);
    expect(out).toContain("should I use npm or pnpm here?");
  });

  it("strips bracketed image markers and tool-loaded boilerplate", () => {
    const input = "Tool loaded. [Image: original 2880x1454] explain this graph view";
    const out = normalizeQueryForRetrieval(input);
    expect(out).not.toMatch(/\[Image:/);
    expect(out).not.toMatch(/Tool loaded/);
    expect(out).toContain("explain this graph view");
  });

  it("compacts whitespace and trims", () => {
    const out = normalizeQueryForRetrieval("  many\n\n  spaces   between\twords  ");
    expect(out).toBe("many spaces between words");
  });

  it("caps very long prompts so embedding latency stays bounded", () => {
    const long = "x ".repeat(5000); // 10000 chars
    const out = normalizeQueryForRetrieval(long);
    expect(out.length).toBeLessThanOrEqual(1200);
  });

  it("returns empty string for empty/whitespace input", () => {
    expect(normalizeQueryForRetrieval("")).toBe("");
    expect(normalizeQueryForRetrieval("   \n\t   ")).toBe("");
  });

  it("leaves clean prompts untouched (modulo whitespace)", () => {
    const clean = "don't use npm, use pnpm";
    expect(normalizeQueryForRetrieval(clean)).toBe(clean);
  });

  it("strips command-name and local-command-stdout wrappers", () => {
    const input = "<command-name>/goal</command-name><command-args>fix the bug</command-args><local-command-stdout>Goal set: …</local-command-stdout>actual ask";
    const out = normalizeQueryForRetrieval(input);
    expect(out).not.toMatch(/<command/);
    expect(out).toContain("actual ask");
  });
});
