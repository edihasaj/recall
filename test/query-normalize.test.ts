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

  it("extracts intent from the leading request instead of an attached PR body", () => {
    const request = "let's do a review of DEVO-29447 https://github.com/dayshape/dayshape/pull/7001";
    const input = [
      request,
      "",
      "## Pull request description",
      ...Array.from({ length: 40 }, (_, index) => (
        `Implementation detail ${index}: adjusted query joins, fixtures, and generated snapshots.`
      )),
    ].join("\n");

    expect(normalizeQueryForRetrieval(input)).toBe("review");
  });

  it("returns empty string for empty/whitespace input", () => {
    expect(normalizeQueryForRetrieval("")).toBe("");
    expect(normalizeQueryForRetrieval("   \n\t   ")).toBe("");
  });

  it("leaves clean prompts untouched (modulo whitespace)", () => {
    const clean = "don't use npm, use pnpm";
    expect(normalizeQueryForRetrieval(clean)).toBe(clean);
  });

  it("keeps the leading request and drops attached GitHub PR metadata", () => {
    const input = `let's do a review of DEVO-29447 https://github.com/dayshape/dayshape/pull/7001

GitHub PR #7001: DEVO-29447: changes to materialization and added tests
https://github.com/dayshape/dayshape/pull/7001
Base: beta-develop
Head: DEVO-29447-economic-columns

## What's Changed?

${"Economic materialization details. ".repeat(100)}`;

    expect(normalizeQueryForRetrieval(input)).toBe("review");
  });

  it("removes artifact identifiers from a short conversational request", () => {
    const input = "please review DEVO-29447 https://github.com/dayshape/dayshape/pull/7001";

    expect(normalizeQueryForRetrieval(input)).toBe("review");
  });

  it("strips command-name and local-command-stdout wrappers", () => {
    const input = "<command-name>/goal</command-name><command-args>fix the bug</command-args><local-command-stdout>Goal set: …</local-command-stdout>actual ask";
    const out = normalizeQueryForRetrieval(input);
    expect(out).not.toMatch(/<command/);
    expect(out).toContain("actual ask");
  });
});
