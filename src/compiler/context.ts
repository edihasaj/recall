import { queryMemories, getMemoryFeedbackSummaries, feedbackWeightedScore } from "../models/memory.js";
import type { RecallDb } from "../db/client.js";
import { recordMemoryInjections } from "../models/memory-injections.js";
import { recordHistoryInjections } from "../models/history-injections.js";
import { CONFIDENCE, type CompilerConfig, type EmbeddingConfig, type HistorySnippet, type MemoryItem } from "../types.js";
import { getRepoQualityProfile } from "../repo/quality.js";
import { hybridSearch, loadEmbeddingConfigFromEnv } from "../embeddings/embeddings.js";
import { listHistorySnippets } from "../history/snippets.js";
import { searchHistorySnippets } from "../history/retrieval.js";

const DEFAULT_CONFIG: CompilerConfig = {
  confidence_threshold: CONFIDENCE.ACTIVE_MIN,
  max_lines: 15,
  max_commands: 3,
  max_gotchas: 3,
  max_history_snippets: 2,
  token_budget: 2000,
  include_candidates: false,
};
const QUERY_RESULT_LIMIT = 2;
const QUERY_VECTOR_RELEVANCE_FLOOR = 0.7;

export interface CompileRequest {
  repo: string;
  path?: string;
  query_text?: string;
  session_id?: string;
  config?: Partial<CompilerConfig>;
  embedding_config?: EmbeddingConfig | null;
}

export interface CompiledContext {
  text: string;
  memories_included: string[];
  memories_dropped: string[];
  history_included: string[];
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
  const selectedHistory = selectRepoHistory(db, req.repo, config.max_history_snippets);

  // 1. Pull repo-scoped + path-scoped memories. Skip rows that have been
  // suppressed from auto-injection (still queryable via MCP). Also include
  // scope='global' rules — those apply across every repo.
  const repoActive = queryMemories(db, {
    repo: req.repo,
    status: "active",
    auto_inject: true,
  });
  const globalActive = queryMemories(db, {
    scope: "global",
    status: "active",
    auto_inject: true,
  });
  const allActive = dedupeById([...repoActive, ...globalActive]);

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

  if (passing.length === 0 && selectedHistory.length === 0) {
    return {
      text: "",
      memories_included: [],
      memories_dropped: dropped.map((m) => m.id),
      history_included: [],
      token_estimate: 0,
    };
  }

  // 4. Sort by feedback-weighted score (cold-start = confidence; matures
  // into followed-rate as resolved samples accumulate). Type priority still
  // groups rules ahead of commands.
  const summaries = getMemoryFeedbackSummaries(db, passing.map((m) => m.id));
  const scored = passing.map((m) => ({
    mem: m,
    score: feedbackWeightedScore(m.confidence, summaries.get(m.id) ?? {
      followed: 0, overridden: 0, contradicted: 0, ignored: 0, resolved: 0,
    }),
  }));
  const sorted = scored
    .sort((a, b) => {
      const typePrio = typePriority(a.mem.type) - typePriority(b.mem.type);
      if (typePrio !== 0) return typePrio;
      return b.score - a.score;
    })
    .map((s) => s.mem);

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
  const text = renderPack(selected, req.repo, selectedHistory);
  const tokenEstimate = Math.ceil(text.length / 4); // rough chars-to-tokens

  if (tokenEstimate > config.token_budget) {
    // Trim from the bottom (lowest confidence)
    while (
      selected.length > 1 &&
      Math.ceil(renderPack(selected, req.repo, selectedHistory).length / 4) >
        config.token_budget
    ) {
      selected.pop();
    }
  }

  const finalText = renderPack(selected, req.repo, selectedHistory);
  recordMemoryInjections(db, {
    memory_ids: selected.map((memory) => memory.id),
    session_id: req.session_id,
    repo: req.repo,
  });
  recordHistoryInjections(db, {
    snippet_ids: selectedHistory.map((snippet) => snippet.id),
    session_id: req.session_id,
    repo: req.repo,
  });

  return {
    text: finalText,
    memories_included: selected.map((m) => m.id),
    memories_dropped: [
      ...dropped.map((m) => m.id),
      ...sorted
        .filter((m) => !selected.includes(m))
        .map((m) => m.id),
    ],
    history_included: selectedHistory.map((snippet) => snippet.id),
    token_estimate: Math.ceil(finalText.length / 4),
  };
}

export async function compileContextHybrid(
  db: RecallDb,
  req: CompileRequest,
): Promise<CompiledContext> {
  const embeddingConfig = req.embedding_config ?? loadEmbeddingConfigFromEnv();
  const profile = getRepoQualityProfile(db, req.repo);
  const config = {
    ...DEFAULT_CONFIG,
    ...req.config,
    confidence_threshold:
      req.config?.confidence_threshold ?? profile.compile_confidence_threshold,
  };
  const selectedHistory = req.query_text
    ? await selectRelevantHistory(db, req.repo, req.query_text, config.max_history_snippets)
    : selectRepoHistory(db, req.repo, config.max_history_snippets);

  const repoMemories = queryMemories(db, { repo: req.repo });
  const globalMemories = queryMemories(db, { scope: "global" });
  const allMemories = dedupeById([...repoMemories, ...globalMemories]).filter((memory) =>
    memory.auto_inject &&
    (memory.status === "active" ||
      (config.include_candidates && memory.status === "candidate"))
  );

  const scoped = req.path
    ? allMemories.filter((memory) => pathMatches(memory, req.path!))
    : allMemories;

  const candidateConfidenceFloor = Math.min(config.confidence_threshold, 0.45);
  const passing = scoped.filter((memory) => {
    if (memory.status === "active") {
      return memory.confidence >= config.confidence_threshold;
    }
    if (memory.status === "candidate" && config.include_candidates) {
      return memory.confidence >= candidateConfidenceFloor;
    }
    return false;
  });

  const dropped = scoped.filter((memory) => !passing.includes(memory));

  if (passing.length === 0 && selectedHistory.length === 0) {
    return {
      text: "",
      memories_included: [],
      memories_dropped: dropped.map((m) => m.id),
      history_included: [],
      token_estimate: 0,
    };
  }

  const retrieval = req.query_text
    ? await hybridSearch(db, req.query_text, embeddingConfig, {
        repo: req.repo,
        limit: QUERY_RESULT_LIMIT,
      })
    : [];

  const retrievalById = new Map(
    retrieval.map((item) => [item.memory.id, item]),
  );

  const summaries = getMemoryFeedbackSummaries(db, passing.map((m) => m.id));
  const emptySummary = { followed: 0, overridden: 0, contradicted: 0, ignored: 0, resolved: 0 };

  const ranked = passing
    .filter((memory) => {
      const retrievalItem = retrievalById.get(memory.id);
      if (req.query_text) {
        if (!retrievalItem) return false;
        if (embeddingConfig && retrievalItem.similarity < QUERY_VECTOR_RELEVANCE_FLOOR) {
          return false;
        }
        return true;
      }
      if (memory.status !== "candidate") return true;
      const retrievalScore = retrievalItem?.score ?? 0;
      return retrievalScore >= 0.2;
    })
    .map((memory) => {
      const retrievalScore = retrievalById.get(memory.id)?.score ?? 0;
      const weighted = feedbackWeightedScore(memory.confidence, summaries.get(memory.id) ?? emptySummary);
      const score = req.query_text
        ? (retrievalScore * 0.45) +
          (weighted * 0.25) +
          (scopeScore(memory, req.path) * 0.15) +
          (freshnessScore(memory) * 0.05) +
          (typeScore(memory.type) * 0.10)
        : (weighted * 0.55) +
          (scopeScore(memory, req.path) * 0.20) +
          (freshnessScore(memory) * 0.10) +
          (typeScore(memory.type) * 0.15);

      return { memory, score };
    })
    .sort((a, b) => b.score - a.score);

  const selected: MemoryItem[] = [];
  let commandCount = 0;
  let gotchaCount = 0;
  let lineCount = 0;

  for (const item of ranked) {
    const memory = item.memory;
    const memLines = memory.text.split("\n").length;

    if (lineCount + memLines > config.max_lines) continue;
    if (memory.type === "command" && commandCount >= config.max_commands) continue;
    if (memory.type === "gotcha" && gotchaCount >= config.max_gotchas) continue;

    selected.push(memory);
    lineCount += memLines;
    if (memory.type === "command") commandCount++;
    if (memory.type === "gotcha") gotchaCount++;
  }

  if (selected.length === 0) {
    const historyOnlyText = renderPack([], req.repo, selectedHistory);
    if (historyOnlyText) {
      recordHistoryInjections(db, {
        snippet_ids: selectedHistory.map((snippet) => snippet.id),
        session_id: req.session_id,
        repo: req.repo,
      });
      return {
        text: historyOnlyText,
        memories_included: [],
        memories_dropped: [...dropped, ...passing].map((m) => m.id),
        history_included: selectedHistory.map((snippet) => snippet.id),
        token_estimate: Math.ceil(historyOnlyText.length / 4),
      };
    }

    return {
      text: "",
      memories_included: [],
      memories_dropped: [...dropped, ...passing].map((m) => m.id),
      history_included: [],
      token_estimate: 0,
    };
  }

  while (
    selected.length > 1 &&
    Math.ceil(renderPack(selected, req.repo, selectedHistory).length / 4) > config.token_budget
  ) {
    selected.pop();
  }

  const finalText = renderPack(selected, req.repo, selectedHistory);
  recordMemoryInjections(db, {
    memory_ids: selected.map((memory) => memory.id),
    session_id: req.session_id,
    repo: req.repo,
  });
  recordHistoryInjections(db, {
    snippet_ids: selectedHistory.map((snippet) => snippet.id),
    session_id: req.session_id,
    repo: req.repo,
  });
  return {
    text: finalText,
    memories_included: selected.map((m) => m.id),
    memories_dropped: [
      ...dropped.map((m) => m.id),
      ...ranked
        .map((item) => item.memory)
        .filter((memory) => !selected.includes(memory))
        .map((memory) => memory.id),
    ],
    history_included: selectedHistory.map((snippet) => snippet.id),
    token_estimate: Math.ceil(finalText.length / 4),
  };
}

// --- Render ---

function renderPack(items: MemoryItem[], repo: string, history: HistorySnippet[] = []): string {
  if (items.length === 0 && history.length === 0) return "";

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

  if (history.length > 0) {
    sections.push(
      "## History\n" + history.map(renderHistorySnippet).join("\n"),
    );
  }

  return `# Recall: ${repo}\n\n${sections.join("\n\n")}\n`;
}

const HISTORY_KINDS = new Set([
  "decision_summary",
  "correction_summary",
  "review_summary",
  "repo_synthesis",
]);

function selectRepoHistory(
  db: RecallDb,
  repo: string,
  limit: number,
): HistorySnippet[] {
  if (limit <= 0) return [];
  return listHistorySnippets(db, { repo, limit: Math.max(limit * 3, 6) })
    .filter((snippet) => !snippet.session_id && HISTORY_KINDS.has(snippet.kind))
    .slice(0, limit);
}

async function selectRelevantHistory(
  db: RecallDb,
  repo: string,
  query: string,
  limit: number,
): Promise<HistorySnippet[]> {
  if (limit <= 0) return [];
  const results = await searchHistorySnippets(db, query, {
    repo,
    limit: Math.max(limit * 3, 6),
  });
  return results
    .map((result) => result.snippet)
    .filter((snippet) => HISTORY_KINDS.has(snippet.kind))
    .slice(0, limit);
}

const HISTORY_ENTRY_MAX_CHARS = 120;
const HISTORY_MAX_ENTRIES_PER_SNIPPET = 2;

function renderHistorySnippet(snippet: HistorySnippet): string {
  const lines = snippet.text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("Repo: ") && !line.endsWith(":"));

  const entries = lines
    .slice(0, HISTORY_MAX_ENTRIES_PER_SNIPPET)
    .map((line) =>
      line.length > HISTORY_ENTRY_MAX_CHARS
        ? line.slice(0, HISTORY_ENTRY_MAX_CHARS - 1).trimEnd() + "…"
        : line,
    );

  const body = entries.length > 0 ? entries.join(" | ") : "";
  return `- [${snippet.kind}] ${body}`;
}

// --- Path matching ---

function pathMatches(mem: MemoryItem, targetPath: string): boolean {
  // Repo, team, and global memories always match
  if (mem.scope === "repo" || mem.scope === "team" || mem.scope === "global") return true;
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

function scopeScore(mem: MemoryItem, targetPath?: string): number {
  if (!targetPath) {
    if (mem.scope === "repo" || mem.scope === "team") return 0.9;
    if (mem.scope === "global") return 0.8;
    return 0.7;
  }
  if (mem.scope === "global") return 0.8;
  if (mem.scope === "path" && mem.path_scope) return 1;
  if (mem.scope === "repo" || mem.scope === "team") return 0.75;
  return pathMatches(mem, targetPath) ? 0.6 : 0;
}

function freshnessScore(mem: MemoryItem): number {
  const basis = mem.last_validated_at ?? mem.last_injected_at ?? mem.updated_at;
  const ageMs = Date.now() - new Date(basis).getTime();
  const ageDays = ageMs / 86_400_000;
  return Math.max(0, 1 - (ageDays / 180));
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

function typeScore(type: MemoryItem["type"]): number {
  switch (type) {
    case "rule":
      return 1.0;
    case "command":
      return 0.95;
    case "decision":
      return 0.9;
    case "gotcha":
      return 0.8;
    case "review_pattern":
      return 0.75;
    default:
      return 0.5;
  }
}

// A memory with scope='global' and a non-null repo (its origin) is returned by
// both `queryMemories({ repo })` and `queryMemories({ scope: "global" })`.
// Dedupe by id so it's rendered once per compile pass.
function dedupeById(memories: MemoryItem[]): MemoryItem[] {
  const seen = new Set<string>();
  const out: MemoryItem[] = [];
  for (const m of memories) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}
