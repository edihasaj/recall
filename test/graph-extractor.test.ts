import { describe, it, expect } from "vitest";
import {
  heuristic,
  mergeExtractions,
  parseLlmExtraction,
} from "../src/graph/extractor.js";

describe("heuristic extractor", () => {
  it("extracts file paths and uses-relations", () => {
    const r = heuristic("Use `src/middleware/auth.ts` and `src/utils/jwt.ts` for token validation.");
    const files = r.entities.filter((e) => e.kind === "file").map((e) => e.name);
    expect(files).toEqual(expect.arrayContaining(["src/middleware/auth.ts", "src/utils/jwt.ts"]));
  });

  it("extracts package names in backticks", () => {
    const r = heuristic("We use `drizzle-orm` and `@modelcontextprotocol/sdk` for the daemon.");
    const libs = r.entities.filter((e) => e.kind === "library").map((e) => e.name).sort();
    expect(libs).toContain("drizzle-orm");
    expect(libs).toContain("@modelcontextprotocol/sdk");
  });

  it("extracts CLI commands", () => {
    const r = heuristic("Always run npm test before committing.");
    const tools = r.entities.filter((e) => e.kind === "tool").map((e) => e.name);
    const commands = r.entities.filter((e) => e.kind === "command").map((e) => e.name);
    expect(tools).toContain("npm");
    expect(commands).toContain("npm test");
  });

  it("extracts URLs and labels them as url entities", () => {
    const r = heuristic("See https://example.com/docs for the api spec.");
    const urls = r.entities.filter((e) => e.kind === "url").map((e) => e.name);
    expect(urls).toEqual(["https://example.com/docs"]);
  });

  it("identifies a replaces-relation between two libraries", () => {
    const r = heuristic("We replaced `jsonwebtoken` with `jose` for Edge runtime compatibility.");
    expect(r.relations.length).toBeGreaterThan(0);
    expect(r.relations[0].relation).toBe("replaces");
  });

  it("identifies a uses-relation between two named entities in a sentence", () => {
    const r = heuristic(
      "The handler in `src/auth/middleware.ts` uses `jose` for token verification.",
    );
    const usesRelation = r.relations.find((rel) => rel.relation === "uses");
    expect(usesRelation).toBeDefined();
  });

  it("drops noise (single digits, bare punctuation)", () => {
    const r = heuristic("Tests pass. 42.");
    expect(r.entities.filter((e) => /^\d+$/.test(e.name))).toHaveLength(0);
  });

  it("dedupes repeated mentions and bumps weight", () => {
    const r = heuristic("`react` is used. `react` is great. Use `react` everywhere.");
    const react = r.entities.find((e) => e.name === "react");
    expect(react).toBeDefined();
    expect(react!.weight).toBeGreaterThanOrEqual(2);
  });
});

describe("parseLlmExtraction", () => {
  it("parses well-formed JSON output", () => {
    const raw = JSON.stringify({
      entities: [
        { kind: "library", name: "jose" },
        { kind: "library", name: "jsonwebtoken" },
      ],
      relations: [
        {
          source: { kind: "library", name: "jose" },
          target: { kind: "library", name: "jsonwebtoken" },
          relation: "replaces",
          confidence: 0.9,
        },
      ],
    });
    const r = parseLlmExtraction(raw);
    expect(r).not.toBeNull();
    expect(r!.entities).toHaveLength(2);
    expect(r!.relations[0].relation).toBe("replaces");
    expect(r!.relations[0].confidence).toBe(0.9);
  });

  it("strips ```json fences", () => {
    const raw = "```json\n" + JSON.stringify({ entities: [{ kind: "tool", name: "npm" }], relations: [] }) + "\n```";
    const r = parseLlmExtraction(raw);
    expect(r?.entities[0].name).toBe("npm");
  });

  it("rejects invalid kinds and relations", () => {
    const r = parseLlmExtraction(
      JSON.stringify({
        entities: [{ kind: "monster", name: "godzilla" }],
        relations: [{ source: { kind: "x", name: "a" }, target: { kind: "y", name: "b" }, relation: "eats" }],
      }),
    );
    expect(r?.entities).toHaveLength(0);
    expect(r?.relations).toHaveLength(0);
  });

  it("returns null for non-JSON garbage", () => {
    expect(parseLlmExtraction("nope, not json")).toBeNull();
  });
});

describe("mergeExtractions", () => {
  it("upgrades heuristic entries to llm when the same key appears", () => {
    const merged = mergeExtractions(
      { entities: [{ kind: "library", name: "jose", source: "heuristic" }], relations: [] },
      { entities: [{ kind: "library", name: "jose", source: "llm" }], relations: [] },
    );
    expect(merged.entities).toHaveLength(1);
    expect(merged.entities[0].source).toBe("llm");
  });

  it("keeps the higher-confidence relation when duplicated", () => {
    const merged = mergeExtractions(
      {
        entities: [],
        relations: [
          {
            source: { kind: "library", name: "a" },
            target: { kind: "library", name: "b" },
            relation: "uses",
            confidence: 0.3,
          },
        ],
      },
      {
        entities: [],
        relations: [
          {
            source: { kind: "library", name: "a" },
            target: { kind: "library", name: "b" },
            relation: "uses",
            confidence: 0.85,
          },
        ],
      },
    );
    expect(merged.relations).toHaveLength(1);
    expect(merged.relations[0].confidence).toBe(0.85);
  });
});
