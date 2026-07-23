import { CONFIDENCE, type MemorySource, type MemoryType } from "../types.js";

export interface ScannedMemoryLike {
  text: string;
  type: MemoryType;
  source: MemorySource;
  confidence: number;
}

export interface EvaluatedScannedMemory {
  action: "keep" | "reject";
  text: string;
  confidence: number;
  reason?: string;
}

const ACTIVE_COMMAND_PATTERNS = [
  /^use\b/i,
];

const PACKAGE_SCRIPT_PATTERN = /^(test|build|lint|dev|start|typecheck|check):\s*`.+`$/i;

const MAKEFILE_TARGETS_PATTERN = /^makefile targets:/i;

// Standard build-lifecycle target names. A `Makefile targets:` line that lists
// only these is a config-scan enumeration, not an actionable instruction.
const GENERIC_MAKE_TARGETS = new Set([
  "all", "bench", "build", "check", "ci", "clean", "coverage", "deploy", "dev",
  "dist", "docs", "fmt", "format", "help", "install", "lint", "release", "run",
  "setup", "start", "test", "tidy", "typecheck",
]);

const CANDIDATE_GOTCHA_PATTERNS = [
  /^next\.js project$/i,
  /^react project\b/i,
  /^vue\.js project$/i,
  /^svelte project$/i,
  /^server framework:/i,
  /^uses alembic\b/i,
];

const ACTIONABLE_RULE_PATTERN = /\b(always|never|must|don't|do not|required|prefer|avoid|use|keep|run|update|add|remove|check|only)\b/i;

export function evaluateScannedMemory(
  input: ScannedMemoryLike,
): EvaluatedScannedMemory {
  const normalized = normalizeScannedText(input.text);
  const lower = normalized.toLowerCase();

  if (!normalized || normalized.length < 12) {
    return reject(normalized, "too_short");
  }

  if (lower.startsWith("setup commands from readme:")) {
    return reject(normalized, "readme_setup_noise");
  }

  if (lower === "what we do not build") {
    return reject(normalized, "section_heading");
  }

  if (/^ci:\s*(github actions|gitlab ci)\b/i.test(normalized)) {
    return reject(normalized, "generic_ci");
  }

  if (/^req-[a-z0-9-]+:/i.test(lower)) {
    return reject(normalized, "spec_requirement");
  }

  if (/^[A-Z][A-Za-z0-9 /_-]{1,80}:$/.test(normalized)) {
    return reject(normalized, "heading");
  }

  if (input.source === "config_parse" && lower.startsWith("linting/formatting: python project")) {
    return reject(normalized, "generic_tooling");
  }

  if (isGenericScannedToolingMemory(input)) {
    return reject(normalized, PACKAGE_SCRIPT_PATTERN.test(normalized)
      ? "generic_package_script"
      : "generic_tooling");
  }

  if (ACTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return keep(normalized, Math.max(input.confidence, 0.62));
  }

  if (input.type === "command") {
    return keep(normalized, toCandidateConfidence(input.confidence));
  }

  if (input.type === "gotcha") {
    if (CANDIDATE_GOTCHA_PATTERNS.some((pattern) => pattern.test(normalized))) {
      return keep(normalized, toCandidateConfidence(input.confidence));
    }
    return reject(normalized, "generic_gotcha");
  }

  if (input.type === "rule") {
    if (!ACTIONABLE_RULE_PATTERN.test(normalized)) {
      return reject(normalized, "non_actionable_rule");
    }
    return keep(normalized, toCandidateConfidence(input.confidence));
  }

  return keep(normalized, toCandidateConfidence(input.confidence));
}

export function isGenericScannedToolingMemory(input: Pick<ScannedMemoryLike, "text" | "type" | "source">): boolean {
  if (input.source !== "config_parse") return false;
  const normalized = normalizeScannedText(input.text);
  const lower = normalized.toLowerCase();
  return (
    (input.type === "command" && PACKAGE_SCRIPT_PATTERN.test(normalized)) ||
    isGenericMakefileTargets(normalized) ||
    lower.startsWith("linting/formatting:")
  );
}

// A `Makefile targets:` line is generic when every listed `make <target>` uses
// a standard build-lifecycle name. A line naming a custom target (e.g.
// `make migrate`, `make seed-db`) is preserved as a candidate instead.
function isGenericMakefileTargets(normalized: string): boolean {
  if (!MAKEFILE_TARGETS_PATTERN.test(normalized)) return false;
  const targets = [...normalized.matchAll(/make\s+([a-z0-9][\w-]*)/gi)].map((m) => m[1].toLowerCase());
  if (targets.length === 0) return true;
  return targets.every((target) => GENERIC_MAKE_TARGETS.has(target));
}

function normalizeScannedText(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .split("\n")
    .map((line) => line.replace(/^[-*#>\s]+/, "").replace(/^\d+\.\s+/, "").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function toCandidateConfidence(confidence: number): number {
  return clamp(confidence, CONFIDENCE.TRANSIENT_MAX + 0.05, CONFIDENCE.ACTIVE_MIN - 0.01);
}

function keep(text: string, confidence: number): EvaluatedScannedMemory {
  return { action: "keep", text, confidence: clamp(confidence) };
}

function reject(text: string, reason: string): EvaluatedScannedMemory {
  return { action: "reject", text, confidence: 0, reason };
}

function clamp(n: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, n));
}
