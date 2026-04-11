import { queryMemories } from "../models/memory.js";
import type { RecallDb } from "../db/client.js";
import { CONFIDENCE, type CompilerConfig, type MemoryItem } from "../types.js";
import { getRepoQualityProfile } from "../repo/quality.js";

const DEFAULT_CONFIG: CompilerConfig = {
  confidence_threshold: CONFIDENCE.ACTIVE_MIN,
  max_lines: 15,
  max_commands: 3,
  max_gotchas: 3,
  token_budget: 2000,
};

export interface CompileRequest {
  repo: string;
  path?: string;
  config?: Partial<CompilerConfig>;
}

export interface CompiledContext {
  text: string;
  memories_included: string[];
  memories_dropped: string[];
  token_estimate: number;
}

export function compileContext(
  db: RecallDb,
  req: CompileRequest,
): CompiledContext {
  const profile = getRepoQualityProfile(db, req.repo);
  const config = {
    ...DEFAULT_CONFIG,
    ...req.config,
    confidence_threshold:
      req.config?.confidence_threshold ?? profile.compile_confidence_threshold,
  };

  // 1. Pull repo-scoped + path-scoped memories
  const allActive = queryMemories(db, {
    repo: req.repo,
    status: "active",
  });

  // 2. Filter by path scope if provided
  const scoped = req.path
    ? allActive.filter((m) => pathMatches(m, req.path!))
    : allActive;

  // 3. Apply hard confidence threshold
  const passing = scoped.filter(
    (m) => m.confidence >= config.confidence_threshold,
  );
  const dropped = scoped.filter(
    (m) => m.confidence < config.confidence_threshold,
  );

  if (passing.length === 0) {
    return {
      text: "",
      memories_included: [],
      memories_dropped: dropped.map((m) => m.id),
      token_estimate: 0,
    };
  }

  // 4. Sort by confidence (highest first), then by type priority
  const sorted = passing.sort((a, b) => {
    const typePrio = typePriority(a.type) - typePriority(b.type);
    if (typePrio !== 0) return typePrio;
    return b.confidence - a.confidence;
  });

  // 5. Budget: pick memories that fit
  const selected: MemoryItem[] = [];
  let commandCount = 0;
  let gotchaCount = 0;
  let lineCount = 0;

  for (const mem of sorted) {
    const memLines = mem.text.split("\n").length;

    if (lineCount + memLines > config.max_lines) continue;
    if (mem.type === "command" && commandCount >= config.max_commands) continue;
    if (mem.type === "gotcha" && gotchaCount >= config.max_gotchas) continue;

    selected.push(mem);
    lineCount += memLines;
    if (mem.type === "command") commandCount++;
    if (mem.type === "gotcha") gotchaCount++;
  }

  // 6. Compile into text
  const text = renderPack(selected, req.repo);
  const tokenEstimate = Math.ceil(text.length / 4); // rough chars-to-tokens

  if (tokenEstimate > config.token_budget) {
    // Trim from the bottom (lowest confidence)
    while (
      selected.length > 1 &&
      Math.ceil(renderPack(selected, req.repo).length / 4) >
        config.token_budget
    ) {
      selected.pop();
    }
  }

  const finalText = renderPack(selected, req.repo);

  return {
    text: finalText,
    memories_included: selected.map((m) => m.id),
    memories_dropped: [
      ...dropped.map((m) => m.id),
      ...sorted
        .filter((m) => !selected.includes(m))
        .map((m) => m.id),
    ],
    token_estimate: Math.ceil(finalText.length / 4),
  };
}

// --- Render ---

function renderPack(items: MemoryItem[], repo: string): string {
  if (items.length === 0) return "";

  const rules = items.filter((m) => m.type === "rule" || m.type === "decision");
  const commands = items.filter((m) => m.type === "command");
  const gotchas = items.filter(
    (m) => m.type === "gotcha" || m.type === "review_pattern",
  );

  const sections: string[] = [];

  if (rules.length > 0) {
    sections.push(
      "## Rules\n" + rules.map((r) => `- ${r.text}`).join("\n"),
    );
  }

  if (commands.length > 0) {
    sections.push(
      "## Commands\n" + commands.map((c) => `- ${c.text}`).join("\n"),
    );
  }

  if (gotchas.length > 0) {
    sections.push(
      "## Gotchas\n" + gotchas.map((g) => `- ${g.text}`).join("\n"),
    );
  }

  return `# Recall: ${repo}\n\n${sections.join("\n\n")}\n`;
}

// --- Path matching ---

function pathMatches(mem: MemoryItem, targetPath: string): boolean {
  // Repo-scoped memories always match
  if (mem.scope === "repo" || mem.scope === "team") return true;
  if (!mem.path_scope) return true;

  // Simple glob-like matching
  const pattern = mem.path_scope;
  if (pattern.endsWith("**")) {
    const prefix = pattern.slice(0, -2);
    return targetPath.startsWith(prefix);
  }
  if (pattern.includes("*")) {
    const regex = new RegExp(
      "^" + pattern.replace(/\*/g, "[^/]*").replace(/\*\*/g, ".*") + "$",
    );
    return regex.test(targetPath);
  }
  return targetPath.startsWith(pattern);
}

// --- Type priority (lower = higher priority) ---

function typePriority(type: MemoryItem["type"]): number {
  switch (type) {
    case "rule":
      return 0;
    case "command":
      return 1;
    case "gotcha":
      return 2;
    case "review_pattern":
      return 3;
    case "decision":
      return 4;
    default:
      return 5;
  }
}
