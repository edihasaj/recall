import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { and, eq, inArray } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { auditTrail, memories } from "../db/schema.js";
import { queueMemoryEmbeddingSync } from "../embeddings/embeddings.js";
import { createMemory, queryMemories, rejectMemory, statusFromConfidence, type CreateMemoryInput } from "../models/memory.js";
import { recordAudit } from "../audit/trail.js";
import { applySupersession } from "../contradictions/supersession.js";
import { getRepoQualityProfile, seedScannedConfidence } from "../repo/quality.js";
import { evaluateScannedMemory } from "./signal.js";
import { readUtf8FileIfExists } from "../security/atomic-file.js";

export interface ScanResult {
  candidates: CreateMemoryInput[];
  repo: string;
}

export function scanRepo(repoPath: string): ScanResult {
  const repoName = inferRepoName(repoPath);
  const candidates: CreateMemoryInput[] = [];

  // Package.json scripts
  candidates.push(...scanPackageJson(repoPath, repoName));

  // Makefile targets
  candidates.push(...scanMakefile(repoPath, repoName));

  // CI config
  candidates.push(...scanCIConfig(repoPath, repoName));

  // Existing instruction files
  candidates.push(...scanInstructionFiles(repoPath, repoName));

  // Linter/formatter configs
  candidates.push(...scanLinterConfigs(repoPath, repoName));

  // README setup sections
  candidates.push(...scanReadme(repoPath, repoName));

  // Python project
  candidates.push(...scanPythonProject(repoPath, repoName));

  return { candidates, repo: repoName };
}

export function scanAndStore(
  db: RecallDb,
  repoPath: string,
  scan: ScanResult = scanRepo(repoPath),
): string[] {
  const { candidates, repo } = scan;
  const profile = getRepoQualityProfile(db, repo);
  const existing = queryMemories(db, { repo })
    .filter((mem) => mem.status !== "rejected");
  const declined = declinedScanTexts(db, repo);
  const ids: string[] = [];

  for (const candidate of candidates) {
    const evaluated = evaluateScannedMemory({
      text: candidate.text,
      type: candidate.type,
      source: candidate.source,
      confidence: seedScannedConfidence(
        candidate.confidence ?? 0.5,
        profile,
      ),
    });
    if (evaluated.action === "reject") {
      continue;
    }

    // Someone already turned this fact down. Re-creating it on every scan
    // brought rejected rules back until cleanup rejected them again.
    if (declined.has(evaluated.text)) continue;

    const seededConfidence = evaluated.confidence;
    const normalizedCandidate = {
      ...candidate,
      text: evaluated.text,
    };
    const duplicate = existing.find((mem) =>
      mem.type === normalizedCandidate.type &&
      mem.source === normalizedCandidate.source &&
      mem.text === normalizedCandidate.text
    );
    if (duplicate) {
      if (duplicate.confidence < seededConfidence) {
        db.update(memories)
          .set({
            confidence: seededConfidence,
            status: statusFromConfidence(seededConfidence),
            text: normalizedCandidate.text,
            updated_at: new Date().toISOString(),
          })
          .where(eq(memories.id, duplicate.id))
          .run();
        queueMemoryEmbeddingSync(db, duplicate.id);
      }
      ids.push(duplicate.id);
      continue;
    }

    normalizedCandidate.confidence = seededConfidence;
    const id = createMemory(db, normalizedCandidate);
    ids.push(id);
    applySupersession(db, id);
    existing.push({
      ...queryMemories(db, { repo }).find((mem) => mem.id === id)!,
      confidence: seededConfidence,
      status: statusFromConfidence(seededConfidence),
    });
  }

  retractUnsupportedScanFacts(db, repoPath, repo, candidates);
  return ids;
}

/**
 * The part of a scan derived from config (lockfiles, scripts, CI, linters),
 * without rules read from instruction files. Instruction lines are extracted
 * heuristically and often come out as fragments; importing them on every
 * session start would turn each AGENTS.md edit into a batch of noisy
 * candidates.
 */
export function derivedScan(scan: ScanResult): ScanResult {
  return {
    ...scan,
    candidates: scan.candidates.filter((candidate) =>
      !(candidate.evidence ?? []).some((entry) =>
        "file" in entry && INSTRUCTION_FILES.includes(String(entry.file)))),
  };
}

/**
 * Texts of scan facts that were rejected for a reason other than the files
 * stopping to support them. A fact the scan itself retracted may come back
 * when the files support it again (a repo switching back to pnpm).
 */
function declinedScanTexts(db: RecallDb, repo: string): Set<string> {
  const rejected = db.select({ id: memories.id, text: memories.text })
    .from(memories)
    .where(and(
      eq(memories.repo, repo),
      eq(memories.status, "rejected"),
      inArray(memories.source, ["repo_scan", "config_parse"]),
    ))
    .all();
  if (rejected.length === 0) return new Set();
  const retracted = new Set(
    db.select({ id: auditTrail.memory_id })
      .from(auditTrail)
      .where(and(
        inArray(auditTrail.memory_id, rejected.map((row) => row.id)),
        eq(auditTrail.actor, "scan_retraction"),
      ))
      .all()
      .map((row) => row.id),
  );
  return new Set(rejected.filter((row) => !retracted.has(row.id)).map((row) => row.text));
}

/**
 * Cheap check for the session-start refresh: does applying this scan change
 * anything? Reads only live scan-fact texts, so an unchanged repo costs a file
 * scan and one small query instead of a full store pass.
 */
export function scanDiffersFromStore(db: RecallDb, scan: ScanResult): boolean {
  const live = new Set(
    db.select({ text: memories.text })
      .from(memories)
      .where(and(
        eq(memories.repo, scan.repo),
        inArray(memories.status, ["active", "candidate"]),
        inArray(memories.source, ["repo_scan", "config_parse"]),
      ))
      .all()
      .map((row) => row.text),
  );
  const declined = declinedScanTexts(db, scan.repo);
  const produced = new Set<string>();
  for (const candidate of scan.candidates) {
    produced.add(candidate.text);
    const evaluated = evaluateScannedMemory({
      text: candidate.text,
      type: candidate.type,
      source: candidate.source,
      confidence: candidate.confidence ?? 0.5,
    });
    if (evaluated.action === "reject") continue;
    produced.add(evaluated.text);
    if (declined.has(evaluated.text)) continue;
    if (!live.has(evaluated.text) && !live.has(candidate.text)) return true;
  }
  for (const text of live) {
    if (!produced.has(text) && SCAN_TEMPLATES.some((template) => template.test(text))) return true;
  }
  return false;
}

const SCAN_SOURCES = new Set(["repo_scan", "config_parse"]);
// Text exactly as the scanner writes it. A reworded fact was curated by a
// person or a refine pass, so a scan no longer producing the template proves
// nothing about it.
const SCAN_TEMPLATES = [
  /^Use (?:npm|pnpm|yarn|bun) as the package manager(?: \(lockfile: [\w.-]+\))?$/,
  /^(?:test|build|lint|dev|start|typecheck|check): `[^`]*`$/,
  /^Makefile targets: /,
  /^CI: /,
  /^(?:Next\.js|Vue\.js|Svelte) project$/,
  /^React project \(no Next\.js\)$/,
  /^Server framework: \w+$/,
  /^Linting\/formatting: /,
  /^Setup commands from README:/,
  /^Use `(?:uv|poetry)` for Python dependency management$/,
  /^Uses Alembic for database migrations$/,
];
const HUMAN_TOUCH_ACTIONS = ["confirmed", "edited", "reactivated", "rolled_back"] as const;

/**
 * Retire scan-derived facts the files no longer support. A scan only ever
 * added facts, so a repo that switched package managers kept telling agents to
 * use the old one indefinitely. A fact is retired only when nothing but the
 * scan vouches for it: no user evidence, no confirm/edit/rollback in its
 * history, and it was derived from config rather than read from an
 * instruction file.
 */
export function retractUnsupportedScanFacts(
  db: RecallDb,
  repoPath: string,
  repo: string,
  candidates: CreateMemoryInput[],
): string[] {
  const supported = new Set<string>();
  for (const candidate of candidates) {
    supported.add(candidate.text);
    const evaluated = evaluateScannedMemory({
      text: candidate.text,
      type: candidate.type,
      source: candidate.source,
      confidence: candidate.confidence ?? 0.5,
    });
    supported.add(evaluated.text);
  }
  const packageJsonBroken = isUnparseableJson(join(repoPath, "package.json"));
  const producedManager = candidates.some((candidate) =>
    /^Use (?:npm|pnpm|yarn|bun) as the package manager/.test(candidate.text));

  const retracted: string[] = [];
  for (const mem of queryMemories(db, { repo })) {
    if (mem.status !== "active" && mem.status !== "candidate") continue;
    if (!SCAN_SOURCES.has(mem.source) || mem.scope !== "repo") continue;
    if (supported.has(mem.text)) continue;
    if (!SCAN_TEMPLATES.some((template) => template.test(mem.text))) continue;
    // Ambiguous lockfiles produce no package-manager fact. Keep the old one
    // while its lockfile is still there rather than leave the repo with none.
    const named = mem.text.match(/^Use (npm|pnpm|yarn|bun) as the package manager/)?.[1];
    if (named && !producedManager && LOCKFILES.some(([manager, file]) =>
      manager === named && existsSync(join(repoPath, file)))) continue;
    if (mem.evidence.length === 0 || mem.evidence.some((e) => e.type !== "repo_scan")) continue;
    const files = new Set(mem.evidence.map((e) => ("file" in e ? String(e.file ?? "") : "")));
    // A half-written package.json should not wipe every fact derived from it.
    if (packageJsonBroken && files.has("package.json")) continue;
    // Rules read from AGENTS.md/CLAUDE.md are a person's words, and older
    // scans stored paraphrases, so a missing line proves nothing. Only facts
    // the scanner derives from config are retracted.
    if ([...files].some((file) => INSTRUCTION_FILES.includes(file))) continue;
    const touched = db.select({ id: auditTrail.id })
      .from(auditTrail)
      .where(and(eq(auditTrail.memory_id, mem.id), inArray(auditTrail.action, [...HUMAN_TOUCH_ACTIONS])))
      .get();
    if (touched) continue;

    rejectMemory(db, mem.id, "scan_retraction");
    recordAudit(db, mem.id, "pruned", "scan_retraction",
      `no longer found by repo scan in ${[...files].filter(Boolean).join(", ") || "repo files"}`);
    retracted.push(mem.id);
  }
  return retracted;
}

const LOCKFILES: [string, string][] = [
  ["pnpm", "pnpm-lock.yaml"],
  ["yarn", "yarn.lock"],
  ["bun", "bun.lockb"],
  ["bun", "bun.lock"],
  ["npm", "package-lock.json"],
];

/**
 * The package manager a repo's lockfiles point to, or null when they
 * disagree. Several lockfiles are common: a stray `pnpm-lock.yaml` that
 * .gitignore hides next to the real `bun.lock`. Only git-tracked lockfiles
 * count then, and a repo that still tracks two gets no fact rather than a
 * guess.
 */
export function lockfileManager(repoPath: string): string | null {
  const present = LOCKFILES.filter(([, file]) => existsSync(join(repoPath, file)));
  const managers = (files: [string, string][]) => [...new Set(files.map(([manager]) => manager))];
  if (managers(present).length <= 1) return managers(present)[0] ?? null;
  let tracked: Set<string>;
  try {
    tracked = new Set(execFileSync("git", ["ls-files", "--", ...present.map(([, file]) => file)], {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).split("\n").filter(Boolean));
  } catch {
    return null;
  }
  const trackedManagers = managers(present.filter(([, file]) => tracked.has(file)));
  return trackedManagers.length === 1 ? trackedManagers[0] : null;
}

function isUnparseableJson(path: string): boolean {
  try {
    const raw = readUtf8FileIfExists(path);
    if (raw === null) return false;
    JSON.parse(raw);
    return false;
  } catch {
    return true;
  }
}

// --- Scanners ---

function scanPackageJson(
  repoPath: string,
  repo: string,
): CreateMemoryInput[] {
  const pkgPath = join(repoPath, "package.json");

  const results: CreateMemoryInput[] = [];
  try {
    const raw = readUtf8FileIfExists(pkgPath);
    if (raw === null) return [];
    const pkg = JSON.parse(raw);

    // Package manager detection
    if (pkg.packageManager) {
      const pm = pkg.packageManager.split("@")[0];
      results.push(makeCommand(
        `Use ${pm} as the package manager (lockfile: ${pm === "pnpm" ? "pnpm-lock.yaml" : pm === "yarn" ? "yarn.lock" : "package-lock.json"})`,
        repo,
        "package.json",
      ));
    } else {
      const manager = lockfileManager(repoPath);
      if (manager) results.push(makeCommand(`Use ${manager} as the package manager`, repo, "package.json"));
    }

    // Key scripts
    const scripts = pkg.scripts ?? {};
    const importantScripts = ["test", "build", "lint", "dev", "start", "typecheck", "check"];
    for (const name of importantScripts) {
      if (scripts[name]) {
        results.push({
          type: "command",
          text: `${name}: \`${scripts[name]}\``,
          scope: "repo",
          repo,
          source: "config_parse",
          confidence: 0.65,
          evidence: [
            { type: "repo_scan", file: "package.json", timestamp: now() },
          ],
        });
      }
    }

    // Framework detection
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };
    if (allDeps.next) results.push(makeGotcha("Next.js project", repo, "package.json"));
    if (allDeps.react && !allDeps.next) results.push(makeGotcha("React project (no Next.js)", repo, "package.json"));
    if (allDeps.vue) results.push(makeGotcha("Vue.js project", repo, "package.json"));
    if (allDeps.svelte) results.push(makeGotcha("Svelte project", repo, "package.json"));
    if (allDeps.express || allDeps.fastify || allDeps.hono)
      results.push(makeGotcha(`Server framework: ${allDeps.express ? "Express" : allDeps.fastify ? "Fastify" : "Hono"}`, repo, "package.json"));

  } catch {
    // bad JSON, skip
  }

  return results;
}

function scanMakefile(
  repoPath: string,
  repo: string,
): CreateMemoryInput[] {
  const mkPath = join(repoPath, "Makefile");

  const results: CreateMemoryInput[] = [];
  try {
    const content = readUtf8FileIfExists(mkPath);
    if (content === null) return [];
    const targets = content.match(/^([a-zA-Z_-]+):/gm);
    if (targets) {
      const key = targets
        .map((t) => t.replace(":", ""))
        .filter((t) =>
          ["test", "build", "lint", "dev", "run", "deploy", "install", "setup", "clean"].includes(t),
        );
      if (key.length > 0) {
        results.push({
          type: "command",
          text: `Makefile targets: ${key.map((t) => `\`make ${t}\``).join(", ")}`,
          scope: "repo",
          repo,
          source: "config_parse",
          confidence: 0.65,
          evidence: [{ type: "repo_scan", file: "Makefile", timestamp: now() }],
        });
      }
    }
  } catch {}

  return results;
}

function scanCIConfig(
  repoPath: string,
  repo: string,
): CreateMemoryInput[] {
  const results: CreateMemoryInput[] = [];

  // GitHub Actions
  const ghDir = join(repoPath, ".github", "workflows");
  if (existsSync(ghDir)) {
    results.push({
      type: "gotcha",
      text: "CI: GitHub Actions (check .github/workflows/ for pipeline config)",
      scope: "repo",
      repo,
      source: "repo_scan",
      confidence: 0.6,
      evidence: [{ type: "repo_scan", file: ".github/workflows/", timestamp: now() }],
    });
  }

  // GitLab CI
  if (existsSync(join(repoPath, ".gitlab-ci.yml"))) {
    results.push(makeGotcha("CI: GitLab CI", repo, ".gitlab-ci.yml"));
  }

  return results;
}

const INSTRUCTION_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  ".github/copilot-instructions.md",
  ".cursorrules",
];

function scanInstructionFiles(
  repoPath: string,
  repo: string,
): CreateMemoryInput[] {
  const results: CreateMemoryInput[] = [];
  for (const file of INSTRUCTION_FILES) {
    const fPath = join(repoPath, file);

    try {
      const content = readUtf8FileIfExists(fPath);
      if (content === null) continue;
      // Extract key rules (lines with "always", "never", "must", "don't")
      const rules = content
        .split("\n")
        .filter((line) =>
          /\b(always|never|must|don't|do not|required|forbidden)\b/i.test(line),
        )
        .map((l) => l.replace(/^[-*#>\s]+/, "").trim())
        .filter((l) => l.length > 10 && l.length < 200);

      for (const rule of rules.slice(0, 5)) {
        results.push({
          type: "rule",
          text: rule,
          scope: "repo",
          repo,
          source: "repo_scan",
          confidence: 0.7, // high — explicit instruction files
          evidence: [{ type: "repo_scan", file, timestamp: now() }],
        });
      }
    } catch {}
  }

  return results;
}

function scanLinterConfigs(
  repoPath: string,
  repo: string,
): CreateMemoryInput[] {
  const results: CreateMemoryInput[] = [];

  const configs: [string, string][] = [
    [".eslintrc.json", "ESLint"],
    [".eslintrc.js", "ESLint"],
    [".eslintrc.cjs", "ESLint"],
    ["eslint.config.js", "ESLint (flat config)"],
    ["eslint.config.mjs", "ESLint (flat config)"],
    [".prettierrc", "Prettier"],
    ["prettier.config.js", "Prettier"],
    ["biome.json", "Biome"],
    ["biome.jsonc", "Biome"],
    [".rustfmt.toml", "rustfmt"],
    ["ruff.toml", "Ruff"],
    ["pyproject.toml", "Python project (pyproject.toml)"],
  ];

  const found: string[] = [];
  for (const [file, name] of configs) {
    if (existsSync(join(repoPath, file))) {
      found.push(name);
    }
  }

  if (found.length > 0) {
    results.push({
      type: "rule",
      text: `Linting/formatting: ${[...new Set(found)].join(", ")}`,
      scope: "repo",
      repo,
      source: "config_parse",
      confidence: 0.65,
      evidence: [{ type: "repo_scan", file: "config files", timestamp: now() }],
    });
  }

  return results;
}

function scanReadme(
  repoPath: string,
  repo: string,
): CreateMemoryInput[] {
  const results: CreateMemoryInput[] = [];
  const readmePath = join(repoPath, "README.md");

  try {
    const content = readUtf8FileIfExists(readmePath);
    if (content === null) return [];

    // Look for setup/install/getting-started sections
    const setupMatch = content.match(
      /^##\s*(setup|install|getting.started|quick.start|development)\s*\n([\s\S]*?)(?=^##\s|\z)/im,
    );

    if (setupMatch) {
      // Extract code blocks from setup section
      const codeBlocks = setupMatch[2].match(/```(?:sh|bash|shell|zsh)?\n([\s\S]*?)```/g);
      if (codeBlocks && codeBlocks.length > 0) {
        const commands = codeBlocks
          .map((b) => b.replace(/```(?:sh|bash|shell|zsh)?\n?/, "").replace(/```$/, "").trim())
          .join("\n");

        if (commands.length < 500) {
          results.push({
            type: "command",
            text: `Setup commands from README:\n${commands}`,
            scope: "repo",
            repo,
            source: "repo_scan",
            confidence: 0.5,
            evidence: [{ type: "repo_scan", file: "README.md", timestamp: now() }],
          });
        }
      }
    }
  } catch {}

  return results;
}

function scanPythonProject(
  repoPath: string,
  repo: string,
): CreateMemoryInput[] {
  const results: CreateMemoryInput[] = [];

  if (existsSync(join(repoPath, "pyproject.toml"))) {
    // Check for uv
    if (existsSync(join(repoPath, "uv.lock"))) {
      results.push(makeCommand("Use `uv` for Python dependency management", repo, "uv.lock"));
    } else if (existsSync(join(repoPath, "poetry.lock"))) {
      results.push(makeCommand("Use `poetry` for Python dependency management", repo, "poetry.lock"));
    }

    // Check for alembic
    if (existsSync(join(repoPath, "alembic.ini")) || existsSync(join(repoPath, "alembic"))) {
      results.push(makeGotcha("Uses Alembic for database migrations", repo, "alembic.ini"));
    }
  }

  return results;
}

// --- Helpers ---

function now(): string {
  return new Date().toISOString();
}

function inferRepoName(repoPath: string): string {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const repo = extractRepoSlugFromRemote(remote);
    if (repo) return repo;
  } catch {}
  return basename(repoPath);
}

function extractRepoSlugFromRemote(remote: string): string | null {
  const trimmed = remote.trim().replace(/\.git$/, "");
  const parts = trimmed.split(/[:/]/).filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts.at(-2)}/${parts.at(-1)}`;
}

function makeCommand(text: string, repo: string, file: string): CreateMemoryInput {
  return {
    type: "command",
    text,
    scope: "repo",
    repo,
    source: "config_parse",
    confidence: 0.65,
    evidence: [{ type: "repo_scan", file, timestamp: now() }],
  };
}

function makeGotcha(text: string, repo: string, file: string): CreateMemoryInput {
  return {
    type: "gotcha",
    text,
    scope: "repo",
    repo,
    source: "repo_scan",
    confidence: 0.6,
    evidence: [{ type: "repo_scan", file, timestamp: now() }],
  };
}
