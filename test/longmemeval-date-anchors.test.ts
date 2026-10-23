import { describe, expect, it } from "vitest";
import {
  discoverSourceDateMentions,
  MAX_SOURCE_TEXT_LENGTH,
  resolveSourceDateExpression,
} from "../benchmark/longmemeval-date-anchors.js";

const NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// Synthetic week: 2026-03-02 is a Monday.
const MONDAY = Date.UTC(2026, 2, 2);
const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dates = (expression: string, observedAt: string) =>
  resolveSourceDateExpression(expression, observedAt).candidates.map((c) => c.date);

describe("resolveSourceDateExpression", () => {
  it("resolves today, yesterday and tomorrow against the recorded day", () => {
    expect(resolveSourceDateExpression("yesterday", "2026-03-15")).toEqual({
      status: "resolved", expression: "yesterday", source_calendar_day: "2026-03-15",
      candidates: [{ date: "2026-03-14", bases: ["observed_day_minus_1"] }],
    });
    expect(resolveSourceDateExpression("Today", "2026-03-15").candidates).toEqual([{ date: "2026-03-15", bases: ["observed_day"] }]);
    expect(resolveSourceDateExpression("TOMORROW", "2026-03-15").candidates).toEqual([{ date: "2026-03-16", bases: ["observed_day_plus_1"] }]);
    expect(Object.keys(resolveSourceDateExpression("today", "2026-03-15")).sort()).toEqual(
      ["candidates", "expression", "source_calendar_day", "status"],
    );
  });

  it("keeps both readings of last weekday for every weekday and observed day", () => {
    for (let observed = 0; observed < 7; observed++) {
      const observedMs = MONDAY + observed * DAY_MS;
      for (let target = 0; target < 7; target++) {
        // Independent oracle: walk back one day at a time / index the previous ISO week.
        let back = 1;
        while (new Date(observedMs - back * DAY_MS).getUTCDay() !== target) back++;
        const previousWeek = iso(MONDAY - 7 * DAY_MS + ((target + 6) % 7) * DAY_MS);
        const expected = [...new Set([iso(observedMs - back * DAY_MS), previousWeek])].sort();
        const result = resolveSourceDateExpression(`last ${NAMES[target]}`, iso(observedMs));
        expect(result.candidates.map((c) => c.date), `${iso(observedMs)} last ${NAMES[target]}`).toEqual(expected);
        expect(result.status).toBe(expected.length > 1 ? "ambiguous" : "resolved");
        expect(result.candidates.flatMap((c) => c.bases).sort()).toEqual(["most_recent_preceding_weekday", "previous_iso_week_weekday"]);
      }
    }
  });

  it("treats the same weekday as seven days ago and merges identical readings", () => {
    const wed = resolveSourceDateExpression("last Wednesday", "2026-03-06"); // Friday
    expect(wed.status).toBe("ambiguous");
    expect(wed.candidates).toEqual([
      { date: "2026-02-25", bases: ["previous_iso_week_weekday"] },
      { date: "2026-03-04", bases: ["most_recent_preceding_weekday"] },
    ]);
    expect(resolveSourceDateExpression("last Friday", "2026-03-06").candidates).toEqual([
      { date: "2026-02-27", bases: ["most_recent_preceding_weekday", "previous_iso_week_weekday"] },
    ]);
    const monWed = resolveSourceDateExpression("last Wednesday", "2026-03-02"); // Monday
    expect(monWed.status).toBe("resolved");
    expect(monWed.candidates).toEqual([
      { date: "2026-02-25", bases: ["most_recent_preceding_weekday", "previous_iso_week_weekday"] },
    ]);
  });

  it("handles the Sunday to Monday ISO week boundary", () => {
    expect(dates("last Monday", "2026-03-08")).toEqual(["2026-02-23", "2026-03-02"]);
    expect(dates("last Sunday", "2026-03-08")).toEqual(["2026-03-01"]);
    expect(dates("last Sunday", "2026-03-09")).toEqual(["2026-03-08"]);
  });

  it("uses the literal recorded calendar day across timezone offsets", () => {
    const west = resolveSourceDateExpression("yesterday", "2026-03-01T23:30:00-05:00");
    expect(west.source_calendar_day).toBe("2026-03-01"); // UTC instant is already 2026-03-02
    expect(west.candidates[0].date).toBe("2026-02-28");
    const east = resolveSourceDateExpression("today", "2026-03-01T00:30:00+09:00");
    expect(east.source_calendar_day).toBe("2026-03-01"); // UTC instant is 2026-02-28
    expect(east.candidates[0].date).toBe("2026-03-01");
    expect(dates("tomorrow", "2026-03-01T12:00:00.123Z")).toEqual(["2026-03-02"]);
  });

  it("applies leap-year rules", () => {
    expect(dates("yesterday", "2024-03-01")).toEqual(["2024-02-29"]);
    expect(dates("yesterday", "2023-03-01")).toEqual(["2023-02-28"]);
    expect(dates("tomorrow", "2024-02-28")).toEqual(["2024-02-29"]);
    expect(dates("tomorrow", "2024-02-29")).toEqual(["2024-03-01"]);
    expect(dates("yesterday", "1900-03-01")).toEqual(["1900-02-28"]);
    expect(dates("yesterday", "2000-03-01")).toEqual(["2000-02-29"]);
    expect(dates("tomorrow", "2025-12-31")).toEqual(["2026-01-01"]);
  });

  it("accepts only optional outer whitespace around a complete expression", () => {
    expect(resolveSourceDateExpression("  \n last\n\t  Wednesday \n", "2026-03-06").status).toBe("ambiguous");
    expect(resolveSourceDateExpression(` today${" ".repeat(1000)}`, "2026-03-06").status).toBe("resolved");
  });

  it("returns unsupported with no candidates for anything larger or different", () => {
    for (const expression of [
      "yesterday last year", "tomorrow next year", "today two years ago", "one year ago today", "two years ago tomorrow",
      "last Friday before Christmas", "last Friday in June", "last Friday 2025-02-14", "last Friday in the office",
      "last Monday of the month", "the day before yesterday", "the day after tomorrow", "three days after last Monday",
      "I met Ana yesterday", "today.", "yesterday, today", "recently", "a while ago", "last week", "last Mon",
      "last Mondays", "lasting Monday", "today-ish", "2 days ago", "next Friday", "last night", "", "   ",
      `last Monday${" ".repeat(100)}of July`, `the day before${" ".repeat(100)}yesterday`, "last Monday\n\nof July",
    ]) {
      const result = resolveSourceDateExpression(expression, "2026-03-06");
      expect(result, JSON.stringify(expression)).toEqual({
        status: "unsupported", expression, source_calendar_day: "2026-03-06", candidates: [],
      });
    }
  });

  it("rejects invalid calendar dates, offsets and inputs even for unsupported expressions", () => {
    for (const bad of [
      "2023-02-29", "2026-13-01", "2026-00-10", "2026-04-31", "2026-03-15T10:00:00", "2026-03-15T10:00:00+24:00",
      "2026-03-15T10:00:00+05:60", "2026-03-15T24:00:00Z", "March 15", "2026-3-5", "", " 2026-03-15",
    ]) {
      expect(() => resolveSourceDateExpression("today", bad), bad).toThrow();
      expect(() => resolveSourceDateExpression("recently", bad), bad).toThrow();
    }
    expect(() => resolveSourceDateExpression("today", 20260315 as unknown as string)).toThrow(TypeError);
    expect(() => resolveSourceDateExpression(null as unknown as string, "2026-03-15")).toThrow(TypeError);
    expect(() => resolveSourceDateExpression("x".repeat(MAX_SOURCE_TEXT_LENGTH + 1), "2026-03-15")).toThrow(RangeError);
    expect(resolveSourceDateExpression("x".repeat(MAX_SOURCE_TEXT_LENGTH), "2026-03-15").status).toBe("unsupported");
  });

  it("enforces years 0000..9999 in validation and arithmetic", () => {
    expect(dates("today", "0000-01-01")).toEqual(["0000-01-01"]);
    expect(dates("tomorrow", "0000-01-01")).toEqual(["0000-01-02"]);
    expect(dates("yesterday", "0001-01-01")).toEqual(["0000-12-31"]);
    expect(dates("yesterday", "0000-03-01")).toEqual(["0000-02-29"]);
    expect(dates("yesterday", "9999-12-31")).toEqual(["9999-12-30"]);
    expect(dates("tomorrow", "0099-12-31")).toEqual(["0100-01-01"]);
    expect(() => resolveSourceDateExpression("yesterday", "0000-01-01")).toThrow(RangeError);
    expect(() => resolveSourceDateExpression("tomorrow", "9999-12-31")).toThrow(RangeError);
    expect(() => resolveSourceDateExpression("last Friday", "0000-01-02")).toThrow(RangeError);
    expect(resolveSourceDateExpression("no date", "0000-01-01").status).toBe("unsupported");
    expect(() => resolveSourceDateExpression("today", "0000-01-01T00:30:00+01:00")).toThrow();
    expect(() => resolveSourceDateExpression("today", "9999-12-31T23:30:00-05:00")).toThrow();
    expect(() => resolveSourceDateExpression("today", "10000-01-01")).toThrow();
  });
});

describe("discoverSourceDateMentions", () => {
  it("reports exact UTF-16 spans around emoji and astral characters", () => {
    const text = "\u{1F600} yesterday \u{1F44D}\u{1F3FD} Last   Friday \u{1D11E}today";
    const mentions = discoverSourceDateMentions(text);
    expect(mentions.map((m) => m.expression)).toEqual(["yesterday", "Last   Friday", "today"]);
    for (const m of mentions) {
      expect(m.start).toBe(text.indexOf(m.expression));
      expect(text.slice(m.start, m.end)).toBe(m.expression);
    }
    expect(mentions[0].start).toBe(3); // the emoji occupies two code units
  });

  it("returns only unresolved locations with no date, clock or candidates", () => {
    expect(discoverSourceDateMentions.length).toBe(1);
    for (const m of discoverSourceDateMentions("I did not go yesterday. I plan to go tomorrow. She never visited last Monday.")) {
      expect(Object.keys(m).sort()).toEqual(["end", "expression", "start", "status"]);
      expect(m.status).toBe("unresolved");
    }
  });

  it("leaves false-positive words inside larger phrases unresolved without dates", () => {
    for (const [text, word] of [
      ["one year ago today", "today"], ["yesterday last year", "yesterday"], ["tomorrow next year", "tomorrow"],
      ["today two years ago", "today"], ["last Friday before Christmas", "last Friday"], ["last Friday in June", "last Friday"],
      ["the day before yesterday", "yesterday"], ["the last Monday of the month", "last Monday"],
    ]) {
      expect(discoverSourceDateMentions(text), text).toEqual([
        { start: text.indexOf(word), end: text.indexOf(word) + word.length, expression: word, status: "unresolved" },
      ]);
    }
  });

  it("ignores vague or partial words and validates its input", () => {
    for (const text of ["recently", "a while ago", "last week", "last Mon", "last Mondays", "yesterdays", "lasting Monday", "today-ish", "next Friday"]) {
      expect(discoverSourceDateMentions(text), text).toEqual([]);
    }
    expect(() => discoverSourceDateMentions(null as unknown as string)).toThrow(TypeError);
    expect(() => discoverSourceDateMentions("x".repeat(MAX_SOURCE_TEXT_LENGTH + 1))).toThrow(RangeError);
    expect(discoverSourceDateMentions("x".repeat(MAX_SOURCE_TEXT_LENGTH))).toEqual([]);
  });
});
