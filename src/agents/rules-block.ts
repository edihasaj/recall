import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { InstallResult, RulesStatus } from "./types.js";

// Shared managed-rules-block helper.
//
// Agents without a hook API (Copilot, Cursor, Windsurf, opencode) can still
// route memory through Recall, but only if their rules file tells them to.
// This is the same fenced-block mechanic claude-code.ts uses for CLAUDE.md,
// generalised so each adapter just supplies a path and a body: re-running
// `recall setup` replaces our block in place and leaves the user's other
// content untouched.

export type { RulesStatus } from "./types.js";

export interface ManagedRulesBlock {
  /** Marker name — rendered as `recall:managed:<name>`. */
  name: string;
  /** Bumped whenever `body` changes so stale blocks are detected and replaced. */
  version: number;
  /** Markdown body placed between the markers. */
  body: string;
  /**
   * When true the whole file belongs to Recall: setup writes it verbatim and
   * uninstall deletes it. Used for dedicated rules files (Cursor .mdc) rather
   * than shared ones (AGENTS.md, copilot-instructions.md).
   */
  ownsFile?: boolean;
  /** Content written above the block when Recall owns the file (e.g. .mdc frontmatter). */
  preamble?: string;
}

export function beginMarker(block: ManagedRulesBlock): string {
  return `<!-- recall:managed:${block.name}:begin v${block.version} -->`;
}

export function endMarker(block: ManagedRulesBlock): string {
  return `<!-- recall:managed:${block.name}:end -->`;
}

function anyBeginMarkerRe(block: ManagedRulesBlock): RegExp {
  return new RegExp(`<!--\\s*recall:managed:${escapeRegExp(block.name)}:begin(?:\\s+v\\d+)?\\s*-->`);
}

function blockRe(block: ManagedRulesBlock): RegExp {
  return new RegExp(
    `<!--\\s*recall:managed:${escapeRegExp(block.name)}:begin(?:\\s+v\\d+)?\\s*-->[\\s\\S]*?<!--\\s*recall:managed:${escapeRegExp(block.name)}:end\\s*-->\\n?`,
    "g",
  );
}

export function renderManagedBlock(block: ManagedRulesBlock): string {
  return `${beginMarker(block)}\n${block.body}\n${endMarker(block)}\n`;
}

export function installManagedRules(
  targetPath: string,
  block: ManagedRulesBlock,
): InstallResult {
  const desired = renderManagedBlock(block);
  const existing = existsSync(targetPath) ? readFileSync(targetPath, "utf-8") : "";

  if (existing.includes(beginMarker(block)) && existing.includes(block.body)) {
    return {
      ok: true,
      changed: false,
      config_path: targetPath,
      message: `Recall rules already current in ${targetPath}`,
    };
  }

  const next = block.ownsFile
    ? `${block.preamble ?? ""}${desired}`
    : mergeIntoExisting(existing, desired, block);

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, next);
  return {
    ok: true,
    changed: true,
    config_path: targetPath,
    message: existing.length === 0
      ? `Created ${targetPath} with Recall rules`
      : `Updated Recall rules in ${targetPath}`,
  };
}

export function uninstallManagedRules(
  targetPath: string,
  block: ManagedRulesBlock,
): InstallResult {
  if (!existsSync(targetPath)) {
    return { ok: true, changed: false, config_path: targetPath, message: `${targetPath} not present` };
  }

  const existing = readFileSync(targetPath, "utf-8");
  if (!anyBeginMarkerRe(block).test(existing)) {
    return {
      ok: true,
      changed: false,
      config_path: targetPath,
      message: `No Recall-managed rules in ${targetPath}`,
    };
  }

  // A file Recall created and still owns can go away entirely; a shared file
  // only loses our block.
  const stripped = existing.replace(blockRe(block), "").replace(/\n{3,}/g, "\n\n");
  if (block.ownsFile && stripped.trim() === (block.preamble ?? "").trim()) {
    rmSync(targetPath, { force: true });
    return { ok: true, changed: true, config_path: targetPath, message: `Removed ${targetPath}` };
  }

  writeFileSync(targetPath, stripped.trim().length === 0 ? "" : ensureTrailingNewline(stripped));
  return {
    ok: true,
    changed: true,
    config_path: targetPath,
    message: `Removed Recall rules from ${targetPath}`,
  };
}

export function checkManagedRules(
  targetPath: string,
  block: ManagedRulesBlock,
): { status: RulesStatus; config_path: string } {
  if (!existsSync(targetPath)) {
    return { status: "absent_no_file", config_path: targetPath };
  }
  const content = readFileSync(targetPath, "utf-8");
  if (!anyBeginMarkerRe(block).test(content)) {
    return { status: "missing", config_path: targetPath };
  }
  return {
    status: content.includes(beginMarker(block)) && content.includes(block.body)
      ? "current"
      : "stale",
    config_path: targetPath,
  };
}

function mergeIntoExisting(
  existing: string,
  desired: string,
  block: ManagedRulesBlock,
): string {
  if (anyBeginMarkerRe(block).test(existing)) {
    return existing.replace(blockRe(block), desired);
  }
  if (existing.length === 0) return desired;
  const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}${desired}`;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Shared body ----------------------------------------------------------
//
// Hookless agents get no automatic capture: nothing observes their prompts or
// tool calls, so the model itself has to call the MCP tools. The body spells
// that out rather than reusing the Claude Code wording, which assumes the
// UserPromptSubmit hook is doing the work.

export function buildRecallRulesBody(toolLabel: string): string {
  return `## Recall (managed by \`recall setup\` — do not edit by hand)

Recall is the single source of truth for durable memory across agents and sessions. It is wired into ${toolLabel} through the \`recall\` MCP server.

- ${toolLabel} has no lifecycle hooks, so capture is **manual**: when the user corrects you, states a durable preference, or says "remember this", call \`capture_correction\` on the \`recall\` MCP server. Phrase it as \`always X\` / \`never Y\`.
- Before non-trivial work in a repo, call \`query\` to pull relevant memories. Do it again when you move to an unfamiliar area.
- A memory that turns out to be wrong or outdated: \`reject\` it. One that proves right: \`confirm\` it.
- Do not keep a second memory store (scratch note files, tool-native memory) — it drifts from Recall.

Reinstall: \`recall setup\`. Remove: \`recall setup --uninstall-hooks\`.`;
}
