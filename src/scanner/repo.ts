import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { memories } from "../db/schema.js";
import { queueMemoryEmbeddingSync } from "../embeddings/embeddings.js";
import { createMemory, queryMemories, statusFromConfidence, type CreateMemoryInput } from "../models/memory.js";
import { getRepoQualityProfile, seedScannedConfidence } from "../repo/quality.js";
import { evaluateScannedMemory } from "./signal.js";
import { readUtf8FileIfExists } from "../security/atomic-file.js";

interface ScanResult {
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

export function scanAndStore(db: RecallDb, repoPath: string): string[] {
  const { candidates, repo } = scanRepo(repoPath);
  const profile = getRepoQualityProfile(db, repo);
  const existing = queryMemories(db, { repo })
    .filter((mem) => mem.status !== "rejected");
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
    existing.push({
      ...queryMemories(db, { repo }).find((mem) => mem.id === id)!,
      confidence: seededConfidence,
      status: statusFromConfidence(seededConfidence),
    });
  }

  return ids;
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
    } else if (existsSync(join(repoPath, "pnpm-lock.yaml"))) {
      results.push(makeCommand("Use pnpm as the package manager", repo, "package.json"));
    } else if (existsSync(join(repoPath, "yarn.lock"))) {
      results.push(makeCommand("Use yarn as the package manager", repo, "package.json"));
    } else if (existsSync(join(repoPath, "bun.lockb")) || existsSync(join(repoPath, "bun.lock"))) {
      results.push(makeCommand("Use bun as the package manager", repo, "package.json"));
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

function scanInstructionFiles(
  repoPath: string,
  repo: string,
): CreateMemoryInput[] {
  const results: CreateMemoryInput[] = [];
  const instructionFiles = [
    "CLAUDE.md",
    "AGENTS.md",
    ".github/copilot-instructions.md",
    ".cursorrules",
  ];

  for (const file of instructionFiles) {
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
