import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import { confirmMemory, createMemory, getMemory, queryMemories, rejectMemory } from "../src/models/memory.js";
import { applySupersession, familyStance, supersessionVerdict, TOOL_FAMILIES } from "../src/contradictions/supersession.js";
import { scanAndStore } from "../src/scanner/repo.js";
import { getAuditTrail, rollbackMemory } from "../src/audit/trail.js";

beforeEach(() => {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
});

let counter = 0;
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "recall-supersede-"));
  return initStandaloneDb(join(dir, `t-${counter++}.db`));
}

function remember(
  db: ReturnType<typeof freshDb>,
  text: string,
  overrides: Record<string, unknown> = {},
): string {
  const id = createMemory(db, {
    text,
    type: "rule",
    source: "user_correction",
    scope: "repo",
    repo: "acme/web",
    confidence: 0.8,
    evidence: [],
    ...overrides,
  } as never);
  confirmMemory(db, id);
  return id;
}

const js = TOOL_FAMILIES.js_package_manager;

describe("familyStance", () => {
  it("reads a choice and what it replaces", () => {
    const s = familyStance("Always use pnpm, not npm, in this repo.", js);
    expect([...s.prefers]).toEqual(["pnpm"]);
    expect([...s.forbids]).toEqual(["npm"]);
  });

  it("treats a command as a mention, not a choice", () => {
    const s = familyStance("Always use `npm run migration:generate` for migrations.", js);
    expect(s.prefers.size).toBe(0);
    expect([...s.mentions]).toEqual(["npm"]);
  });

  it("keeps a narrow-purpose choice out of supersession", () => {
    const s = familyStance("Always use pnpm for Recall e2e verification.", js);
    expect(s.prefers.size).toBe(0);
    expect([...s.scoped]).toEqual(["pnpm"]);
  });

  it("does not read pnpm as npm, or PiP as pip", () => {
    expect([...familyStance("Use pnpm as the package manager", js).mentions]).toEqual(["pnpm"]);
    expect(familyStance("PiP does NOT work in Simulator", TOOL_FAMILIES.python_package_manager).mentions.size).toBe(0);
  });

  it("retires every tool in an 'instead of' list", () => {
    const s = familyStance("The backend uses uv instead of pip or poetry.", TOOL_FAMILIES.python_package_manager);
    expect([...s.prefers]).toEqual(["uv"]);
    expect([...s.forbids].sort()).toEqual(["pip", "poetry"]);
  });
});

describe("supersessionVerdict", () => {
  it("supersedes an older conflicting choice", () => {
    expect(supersessionVerdict({ text: "Use pnpm instead of npm." }, { text: "Use npm as the package manager" })?.action)
      .toBe("superseded");
  });

  it("ripples into memories built on the retired tool", () => {
    expect(supersessionVerdict({ text: "We switched to pnpm." }, { text: "Run `npm run build` before committing." })?.action)
      .toBe("rippled");
  });

  it("leaves mixed memories and unrelated memories alone", () => {
    const newer = { text: "Use pnpm as the package manager." };
    expect(supersessionVerdict(newer, { text: "Run pnpm lint for web, or npm run lint for the API." })).toBeNull();
    expect(supersessionVerdict(newer, { text: "Keep imports at the top of each file." })).toBeNull();
    expect(supersessionVerdict(newer, { text: "Use pnpm as the package manager (lockfile: pnpm-lock.yaml)" })).toBeNull();
  });

  it("does not ripple when the caller forbids it", () => {
    expect(supersessionVerdict({ text: "Use pnpm." }, { text: "Run `npm test`." }, false)).toBeNull();
  });
});

describe("applySupersession", () => {
  it("rejects the old choice, demotes dependents, links, and can be rolled back", () => {
    const db = freshDb();
    const oldChoice = remember(db, "Use npm as the package manager");
    const dependent = remember(db, "Run `npm run build` before committing.");
    const unrelated = remember(db, "Keep imports at the top of each file.");
    const newer = remember(db, "Use pnpm instead of npm.");

    const changes = applySupersession(db, newer);

    expect(changes.map((c) => c.action).sort()).toEqual(["rippled", "superseded"]);
    expect(getMemory(db, oldChoice)?.status).toBe("rejected");
    expect(getMemory(db, dependent)?.status).toBe("candidate");
    expect(getMemory(db, unrelated)?.status).toBe("active");
    expect(getMemory(db, newer)?.supersedes).toBe(oldChoice);

    const trail = getAuditTrail(db, oldChoice);
    expect(trail.some((e) => e.actor === "supersession" && /newer js_package_manager choice/.test(e.reason ?? ""))).toBe(true);
    const snapshot = trail.find((e) => e.action === "rejected" && e.before_snapshot);
    expect(snapshot).toBeTruthy();
    expect(rollbackMemory(db, oldChoice, snapshot!.id, "test")).toBe(true);
    expect(getMemory(db, oldChoice)?.status).toBe("active");
  });

  it("never lets a repo scan retire what a person said", () => {
    const db = freshDb();
    const human = remember(db, "Use pnpm instead of npm.");
    const scan = remember(db, "Use npm as the package manager", {
      source: "config_parse",
      type: "command",
      evidence: [{ type: "repo_scan", file: "package.json", timestamp: new Date().toISOString() }],
    });
    expect(applySupersession(db, scan)).toEqual([]);
    expect(getMemory(db, human)?.status).toBe("active");
  });

  it("does not let a repo rule retire a global one, or touch other repos", () => {
    const db = freshDb();
    const global = remember(db, "Use pnpm as the package manager", { scope: "global", repo: null });
    const otherRepo = remember(db, "Use yarn as the package manager", { repo: "acme/other" });
    const newer = remember(db, "Use npm as the package manager for this repo.");
    expect(applySupersession(db, newer)).toEqual([]);
    expect(getMemory(db, global)?.status).toBe("active");
    expect(getMemory(db, otherRepo)?.status).toBe("active");
  });
});

describe("scanAndStore", () => {
  function repoDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "recall-scan-repo-"));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
  }
  const live = (db: ReturnType<typeof freshDb>, repo: string) =>
    queryMemories(db, { repo }).filter((m) => m.status !== "rejected").map((m) => m.text);

  it("replaces the old package manager when the lockfile changes", () => {
    const db = freshDb();
    const dir = repoDir({ "package.json": "{}", "pnpm-lock.yaml": "" });
    scanAndStore(db, dir);
    const repo = queryMemories(db, {})[0].repo!;
    expect(live(db, repo)).toContain("Use pnpm as the package manager");

    rmSync(join(dir, "pnpm-lock.yaml"));
    writeFileSync(join(dir, "package-lock.json"), "{}");
    scanAndStore(db, dir);

    expect(live(db, repo)).toContain("Use npm as the package manager");
    expect(live(db, repo)).not.toContain("Use pnpm as the package manager");
  });

  it("keeps a scan fact a person confirmed after its lockfile disappears", () => {
    const db = freshDb();
    const dir = repoDir({ "package.json": "{}", "pnpm-lock.yaml": "" });
    scanAndStore(db, dir);
    const repo = queryMemories(db, {})[0].repo!;
    const fact = queryMemories(db, { repo }).find((m) => m.text === "Use pnpm as the package manager")!;
    confirmMemory(db, fact.id);

    rmSync(join(dir, "pnpm-lock.yaml"));
    scanAndStore(db, dir);
    expect(live(db, repo)).toContain("Use pnpm as the package manager");
  });

  it("keeps facts while package.json is half-written", () => {
    const db = freshDb();
    const dir = repoDir({ "package.json": "{}", "pnpm-lock.yaml": "" });
    scanAndStore(db, dir);
    const repo = queryMemories(db, {})[0].repo!;

    writeFileSync(join(dir, "package.json"), "{ half-written");
    scanAndStore(db, dir);
    expect(live(db, repo)).toContain("Use pnpm as the package manager");
  });

  it("does not re-create a fact someone rejected", () => {
    const db = freshDb();
    const dir = repoDir({ "package.json": "{}", "pnpm-lock.yaml": "" });
    scanAndStore(db, dir);
    const repo = queryMemories(db, {})[0].repo!;
    const fact = queryMemories(db, { repo }).find((m) => m.text === "Use pnpm as the package manager")!;
    rejectMemory(db, fact.id, "cli");

    scanAndStore(db, dir);
    expect(live(db, repo)).not.toContain("Use pnpm as the package manager");
    expect(queryMemories(db, { repo }).filter((m) => m.text === "Use pnpm as the package manager")).toHaveLength(1);
  });

  it("brings a retracted fact back when the files support it again", () => {
    const db = freshDb();
    const dir = repoDir({ "package.json": "{}", "pnpm-lock.yaml": "" });
    scanAndStore(db, dir);
    const repo = queryMemories(db, {})[0].repo!;
    rmSync(join(dir, "pnpm-lock.yaml"));
    scanAndStore(db, dir);
    expect(live(db, repo)).not.toContain("Use pnpm as the package manager");

    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    scanAndStore(db, dir);
    expect(live(db, repo)).toContain("Use pnpm as the package manager");
  });

  it("never retracts rules read from instruction files", () => {
    const db = freshDb();
    const dir = repoDir({ "AGENTS.md": "- Always run the full gate before handing off work.\n" });
    scanAndStore(db, dir);
    const repo = queryMemories(db, {})[0].repo!;

    writeFileSync(join(dir, "AGENTS.md"), "# nothing here\n");
    scanAndStore(db, dir);
    expect(live(db, repo)).toContain("Always run the full gate before handing off work.");
  });
});
