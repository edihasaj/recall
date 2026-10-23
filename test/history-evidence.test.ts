import { describe, expect, it } from "vitest";
import { preferredEvidenceSpeaker, renderEvidenceSources } from "../src/history/evidence.js";

describe("history evidence renderer", () => {
  it("uses a late matching correction instead of an unrelated prefix", () => {
    const text = [
      "Archived dashboard discussion one.",
      "Archived dashboard discussion two.",
      "Zephyr workers now run in Helsinki; the Oslo location is obsolete.",
    ].join("\n");
    const result = renderEvidenceSources([{ text }], {
      query: "Zephyr worker location", max_chars: 160, per_source_chars: 100,
    });
    expect(result.text).toContain("Helsinki");
    expect(result.text).toContain("Oslo location is obsolete");
    expect(result.text).not.toContain("discussion one");
    expect(result.sources[0]!.ranges[0]!.start).toBeGreaterThan(0);
  });

  it("preserves negative wording and exact source slices", () => {
    const text = "Do not use npm. Use pnpm for every workspace.";
    const result = renderEvidenceSources([{ text }], {
      query: "don't use npm", max_chars: 120,
    });
    expect(result.text).toContain("Do not use npm.");
    const source = result.sources[0]!;
    expect(source.used_chars).toBe(
      source.ranges.reduce((sum, range) => sum + range.end - range.start, 0),
    );
    expect(source.ranges.map((range) => text.slice(range.start, range.end)).join("")).toContain("Do not use npm.");
  });

  it("shares a total budget so a short later source is retained", () => {
    const result = renderEvidenceSources([
      { text: "A ".repeat(300) + "\nZephyr is in Helsinki." },
      { text: "Oslo is obsolete." },
    ], { query: "Zephyr Oslo", max_chars: 100, per_source_chars: 600 });
    expect(result.text.length).toBeLessThanOrEqual(100);
    expect(result.text).toContain("## Memory 1");
    expect(result.text).toContain("## Memory 2");
    expect(result.text).toContain("Oslo is obsolete.");
  });

  it("orders valid observations chronologically while retaining input identity", () => {
    const result = renderEvidenceSources([
      { text: "later", observed_at: "2026-10-03" },
      { text: "unknown", observed_at: "tomorrow" },
      { text: "earlier", observed_at: "2026-09-30T12:00:00Z", date_kind: "record_updated" },
      { text: "year zero", observed_at: "0000-02-29" },
    ], { max_chars: 300 });
    expect(result.text.indexOf("year zero")).toBeLessThan(result.text.indexOf("earlier"));
    expect(result.text.indexOf("earlier")).toBeLessThan(result.text.indexOf("later"));
    expect(result.text).toContain("Record updated: 2026-09-30T12:00:00Z");
    expect(result.text).toContain("Observed: 2026-10-03");
    expect(result.text).not.toContain("tomorrow");
    expect(result.sources.map((source) => source.source_index)).toEqual([0, 1, 2, 3]);
  });

  it("handles duplicate content deterministically without exposing identifiers", () => {
    const sources = [{ text: "same evidence" }, { text: "same evidence" }];
    const one = renderEvidenceSources(sources, { max_chars: 100 });
    const two = renderEvidenceSources(sources, { max_chars: 100 });
    expect(one).toEqual(two);
    expect(one.text).toContain("## Memory 1");
    expect(one.text).toContain("## Memory 2");
  });

  it("does not split a Unicode surrogate pair at an excerpt boundary", () => {
    const text = "irrelevant ".repeat(20) + "\nZephyr 😀 is in Helsinki.";
    const result = renderEvidenceSources([{ text }], {
      query: "Zephyr Helsinki", max_chars: 75, per_source_chars: 25,
    });
    for (const range of result.sources[0]!.ranges) {
      expect(text.slice(range.start, range.end)).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(text.slice(range.start, range.end)).not.toMatch(/^[\uDC00-\uDFFF]/);
    }
  });

  it("omits invalid dates and tracks empty or omitted sources", () => {
    const result = renderEvidenceSources([
      { text: "" },
      { text: "valid", observed_at: "2026-02-29" },
      { text: "cut off" },
    ], { max_chars: 21 });
    expect(result.text).not.toContain("2026-02-29");
    expect(result.sources).toHaveLength(3);
    expect(result.sources[0]).toMatchObject({ used_chars: 0, truncated: false });
    expect(result.sources[2]!.used_chars).toBe(0);
    expect(result.sources[2]!.truncated).toBe(true);
  });

  it("honors a tiny per-source cap under a huge shared budget", () => {
    const result = renderEvidenceSources([
      { text: "a".repeat(10_000) + "\naaaa" },
      { text: "b".repeat(10_000) + "\nbbbb" },
    ], { max_chars: 1_000_000, per_source_chars: 4 });
    expect(result.text.length).toBeLessThan(100);
    expect(result.sources.map((source) => source.used_chars)).toEqual([4, 4]);
  });

  it("omits an oversized turn rather than changing its governed meaning", () => {
    const text = "user: I do not agree that "
      + "for unrelated reasons ".repeat(30)
      + "Zephyr production uses Redis instead of Postgres.";
    const result = renderEvidenceSources([{ text }], {
      query: "Zephyr production", max_chars: 600, per_source_chars: 420,
    });
    expect(result.text).toBe("");
    expect(result.sources[0]).toMatchObject({ ranges: [], used_chars: 0, truncated: true });
  });

  it("retains a complete speaker-attributed correction", () => {
    const text = [
      "irrelevant background ".repeat(30),
      "assistant: My colleague suggested Zephyr uses Redis. That is incorrect; it uses Postgres.",
      "user: Zephyr production uses Redis only in a test fixture.",
    ].join("\n");
    const result = renderEvidenceSources([{ text }], {
      query: "Zephyr Redis", max_chars: 300, per_source_chars: 200,
    });
    expect(result.text).toContain("assistant: My colleague suggested Zephyr uses Redis.");
    expect(result.text).toContain("That is incorrect; it uses Postgres.");
    expect(result.text).toContain("user: Zephyr production uses Redis only in a test fixture.");
    expect(result.text).not.toContain("irrelevant background");
  });

  it("retains a governing heading adjacent to the matched line", () => {
    const result = renderEvidenceSources([{
      text: [
        "Rejected options:",
        "- Deploy Zephyr to Oslo.",
        "archive ".repeat(40),
      ].join("\n"),
    }], { query: "Zephyr Oslo", max_chars: 220, per_source_chars: 80 });
    expect(result.text).toContain("Rejected options:");
    expect(result.text).toContain("- Deploy Zephyr to Oslo.");
  });

  it("includes far-apart matching facts from the same source", () => {
    const result = renderEvidenceSources([{
      text: [
        "Zephyr uses Redis in production.",
        "archived context ".repeat(30),
        "Zephyr uses Postgres in local tests.",
      ].join("\n"),
    }], { query: "Zephyr", max_chars: 500, per_source_chars: 400 });
    expect(result.text).toContain("Zephyr uses Redis in production.");
    expect(result.text).toContain("Zephyr uses Postgres in local tests.");
  });

  it("omits a governed list item when its required negative heading cannot fit", () => {
    const result = renderEvidenceSources([{
      text: [
        "Rejected because the security review found an unsafe rollout path ".repeat(10),
        "- Deploy Zephyr to Oslo.",
      ].join("\n"),
    }], { query: "Zephyr Oslo", max_chars: 200, per_source_chars: 80 });
    expect(result.text).toBe("");
    expect(result.sources[0]!.ranges).toEqual([]);
  });

  it("does not add a governed neighbor after selecting a later match", () => {
    const result = renderEvidenceSources([{
      text: [
        `Rejected for security: ${"unsafe rollout ".repeat(40)}:`,
        "- Deploy Zephyr to Oslo.",
        "user: Helsinki is the current city.",
      ].join("\n"),
    }], { query: "Helsinki", max_chars: 200, per_source_chars: 80 });
    expect(result.text).toContain("user: Helsinki is the current city.");
    expect(result.text).not.toContain("Deploy Zephyr to Oslo.");
  });

  it("retains all enclosing heading scope for a nested matching list item", () => {
    const result = renderEvidenceSources([{
      text: [
        "Rejected options:",
        "  Backend deployment choices:",
        "    - Deploy Zephyr to Oslo.",
        "archive ".repeat(100),
      ].join("\n"),
    }], { query: "Zephyr Oslo", max_chars: 200, per_source_chars: 80 });
    expect(result.text).toContain("Rejected options:");
    expect(result.text).toContain("Backend deployment choices:");
    expect(result.text).toContain("- Deploy Zephyr to Oslo.");
  });

  it("uses the first complete source turn for a semantic no-overlap fallback", () => {
    const result = renderEvidenceSources([{
      text: "user: The fleet is based in the Finnish capital.\n"
        + "irrelevant archival line.\n".repeat(30),
    }], {
      query: "Where are Zephyr workers located?", max_chars: 1_000, per_source_chars: 420,
    });
    expect(result.text).toContain("user: The fleet is based in the Finnish capital.");
  });

  it("prefers direct user evidence over crowded assistant wording within the source budget", () => {
    const query = "Where do Sora workers live?";
    const source = {
      text: [
        "user: Sora workers live in the hills.",
        "assistant: Sora workers live near the harbor for ideas.",
        "assistant: Sora workers live by the harbor with options.",
        "assistant: Sora workers live near the harbor while planning.",
      ].join("\n"),
    };
    const result = renderEvidenceSources([source], {
      query,
      preferred_speaker: preferredEvidenceSpeaker(query),
      max_chars: 200,
      per_source_chars: 70,
    });
    const unpreferred = renderEvidenceSources([source], {
      query,
      max_chars: 200,
      per_source_chars: 70,
    });
    expect(result.text).toContain("user: Sora workers live in the hills.");
    expect(result.text).not.toContain("while planning");
    expect(unpreferred.text).toContain("while planning");
  });

  it("prefers assistant evidence when asking about prior assistant advice", () => {
    const query = "Which book did you recommend earlier?";
    const result = renderEvidenceSources([{
      text: [
        "user: I want book recommendations about astronomy.",
        "assistant: I recommended The Glass Orchard for a quiet evening.",
        "user: I later borrowed another book.",
      ].join("\n"),
    }], {
      query,
      preferred_speaker: preferredEvidenceSpeaker(query),
      max_chars: 200,
      per_source_chars: 80,
    });
    expect(preferredEvidenceSpeaker(query)).toBe("assistant");
    expect(result.text).toContain("assistant: I recommended The Glass Orchard for a quiet evening.");
    expect(result.text).not.toContain("later borrowed");
  });

  it("uses user preference for a fresh recommendation request", () => {
    expect(preferredEvidenceSpeaker("Can you recommend a book for me?")).toBe("user");
    expect(preferredEvidenceSpeaker("What did you recommend?")).toBe("assistant");
    expect(preferredEvidenceSpeaker("Which book did you suggest earlier?")).toBe("assistant");
    expect(preferredEvidenceSpeaker("What was your earlier advice?")).toBe("assistant");
    expect(preferredEvidenceSpeaker("Can you remind me of the book you recommended for bedtime?")).toBe("assistant");
    expect(preferredEvidenceSpeaker("What was the seventh task in the list you provided?")).toBe("assistant");
    expect(preferredEvidenceSpeaker("In our previous chat, you suggested other options; what were they?")).toBe("assistant");
    expect(preferredEvidenceSpeaker("What books have you recommended?")).toBe("assistant");
  });

  it("uses a deterministic fallback when a query has only generic terms", () => {
    const result = renderEvidenceSources([{
      text: "user: Sora workers moved to the hills.\n" + "archive entry.\n".repeat(40),
    }], {
      query: "What did you have for me?",
      max_chars: 800,
      per_source_chars: 100,
    });
    expect(result.text).toContain("user: Sora workers moved to the hills.");
  });

  it("leaves unmarked source text unchanged when a speaker is preferred", () => {
    const sources = [{
      text: [
        "Sora workers now live in the hills.",
        "Sora workers once considered the harbor.",
      ].join("\n"),
    }];
    const baseline = renderEvidenceSources(sources, {
      query: "Where do Sora workers live?",
      max_chars: 200,
      per_source_chars: 80,
    });
    const preferred = renderEvidenceSources(sources, {
      query: "Where do Sora workers live?",
      preferred_speaker: "user",
      max_chars: 200,
      per_source_chars: 80,
    });
    expect(preferred).toEqual(baseline);
  });

  it("preserves literal role labels as source attribution without adding authority", () => {
    const result = renderEvidenceSources([{
      text: "assistant: Publish the notes after the editor confirms it.",
    }], { query: "Publish notes", preferred_speaker: "assistant", max_chars: 200 });
    expect(result.text).toContain("assistant: Publish the notes after the editor confirms it.");
    expect(result.text).not.toContain("[trusted]");
    expect(result.text).not.toContain("[authorized]");
  });

  it("returns empty text for no sources and rejects unusable budgets", () => {
    expect(renderEvidenceSources([], { max_chars: 1 })).toEqual({ text: "", sources: [] });
    expect(() => renderEvidenceSources([{ text: "x" }], { max_chars: 0 })).toThrow("max_chars");
    expect(() => renderEvidenceSources([{ text: "x" }], { max_chars: 3 })).toThrow("too small");
    expect(() => renderEvidenceSources([{ text: "x" }], { max_chars: 20, per_source_chars: 0 })).toThrow("per_source_chars");
  });
});
