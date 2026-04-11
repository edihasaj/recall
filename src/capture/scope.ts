/**
 * Scope inference improvements — better detection of whether a correction
 * applies to a file, directory, repo, or team scope.
 *
 * Signals used:
 *   - file extension / type of the context file
 *   - directory depth and structure
 *   - language/framework indicators in the correction text
 *   - explicit scope markers ("in this file", "for this repo", "for all projects")
 *   - git ownership patterns
 */

import { execSync } from "node:child_process";
import { dirname, extname, basename } from "node:path";
import type { MemoryScope } from "../types.js";

export interface ScopeInference {
  scope: MemoryScope;
  path_scope: string | null;
  confidence_modifier: number;
  reason: string;
}

// --- Explicit scope markers ---

const SCOPE_MARKERS: Array<{
  pattern: RegExp;
  scope: MemoryScope;
  reason: string;
}> = [
  {
    pattern: /\b(in this file|this file only|just this file)\b/i,
    scope: "path",
    reason: "explicit file scope marker",
  },
  {
    pattern: /\b(in this directory|in this folder|this dir)\b/i,
    scope: "path",
    reason: "explicit directory scope marker",
  },
  {
    pattern: /\b(in this repo|for this repo|repo-wide|across the repo|this project)\b/i,
    scope: "repo",
    reason: "explicit repo scope marker",
  },
  {
    pattern: /\b(for all projects|everywhere|all repos|team-wide|company-wide|org-wide)\b/i,
    scope: "team",
    reason: "explicit team/org scope marker",
  },
  {
    pattern: /\b(just for now|this time|for this task|temporarily)\b/i,
    scope: "session",
    reason: "explicit session scope marker",
  },
];

// --- Language/framework indicators that suggest repo scope ---

const FRAMEWORK_INDICATORS: RegExp[] = [
  /\b(typescript|javascript|python|rust|go|java|swift|ruby)\b/i,
  /\b(react|vue|angular|svelte|next\.?js|express|fastify|django|flask|rails)\b/i,
  /\b(eslint|prettier|biome|ruff|clippy|rubocop)\b/i,
  /\b(jest|vitest|pytest|cargo test|go test)\b/i,
  /\b(npm|yarn|pnpm|bun|pip|uv|poetry|cargo|go mod)\b/i,
];

// --- File type → likely scope ---

const FILE_TYPE_SCOPES: Record<string, MemoryScope> = {
  // Config files → repo scope
  ".json": "repo",
  ".yaml": "repo",
  ".yml": "repo",
  ".toml": "repo",
  ".ini": "repo",
  // Source files → path scope
  ".ts": "path",
  ".tsx": "path",
  ".js": "path",
  ".jsx": "path",
  ".py": "path",
  ".rs": "path",
  ".go": "path",
  ".swift": "path",
  ".java": "path",
  ".rb": "path",
  // Test files → path scope
  ".test.ts": "path",
  ".spec.ts": "path",
  ".test.js": "path",
  ".spec.js": "path",
};

// --- Main inference function ---

export function inferScope(
  correctionText: string,
  contextPath?: string,
  repoPath?: string,
): ScopeInference {
  // 1. Check explicit scope markers (highest priority)
  for (const marker of SCOPE_MARKERS) {
    if (marker.pattern.test(correctionText)) {
      return {
        scope: marker.scope,
        path_scope: marker.scope === "path" && contextPath
          ? inferPathScope(contextPath)
          : null,
        confidence_modifier: 0.1, // boost for explicit markers
        reason: marker.reason,
      };
    }
  }

  // 2. Check if correction mentions framework/language → repo scope
  for (const indicator of FRAMEWORK_INDICATORS) {
    if (indicator.test(correctionText)) {
      return {
        scope: "repo",
        path_scope: null,
        confidence_modifier: 0.05,
        reason: "language/framework reference implies repo scope",
      };
    }
  }

  // 3. If we have a context path, infer from file type
  if (contextPath) {
    const ext = extname(contextPath);
    const base = basename(contextPath);

    // Test files → narrow path scope
    if (
      base.includes(".test.") ||
      base.includes(".spec.") ||
      contextPath.includes("__tests__") ||
      contextPath.includes("/test/")
    ) {
      return {
        scope: "path",
        path_scope: inferPathScope(contextPath),
        confidence_modifier: 0,
        reason: "test file context → path scope",
      };
    }

    // Config files → repo scope
    if (
      FILE_TYPE_SCOPES[ext] === "repo" ||
      base === "package.json" ||
      base === "tsconfig.json" ||
      base === "Makefile"
    ) {
      return {
        scope: "repo",
        path_scope: null,
        confidence_modifier: 0.05,
        reason: "config file context → repo scope",
      };
    }

    // Source files → path scope (directory-level)
    if (FILE_TYPE_SCOPES[ext] === "path") {
      return {
        scope: "path",
        path_scope: inferPathScope(contextPath),
        confidence_modifier: 0,
        reason: "source file context → directory scope",
      };
    }
  }

  // 4. Analyze correction text for specificity
  if (hasSpecificFileReference(correctionText)) {
    return {
      scope: "path",
      path_scope: extractPathFromText(correctionText),
      confidence_modifier: 0,
      reason: "specific file/path reference in correction",
    };
  }

  // 5. Check git ownership for context (optional, slower)
  if (contextPath && repoPath) {
    const ownerScope = inferFromGitOwnership(contextPath, repoPath);
    if (ownerScope) return ownerScope;
  }

  // Default: repo scope (most common for corrections)
  return {
    scope: "repo",
    path_scope: null,
    confidence_modifier: 0,
    reason: "default: no specific scope signals detected",
  };
}

// --- Helpers ---

function inferPathScope(filePath: string): string {
  // Use parent directory with glob
  const dir = dirname(filePath);
  return `${dir}/**`;
}

function hasSpecificFileReference(text: string): boolean {
  return /\b[\w-]+\.(ts|js|py|rs|go|swift|java|rb|tsx|jsx|vue|svelte)\b/.test(text) ||
    /\b(src|lib|app|components|utils|test|spec)\//.test(text);
}

function extractPathFromText(text: string): string | null {
  // Try to extract a file path
  const pathMatch = text.match(
    /\b((?:src|lib|app|components|utils|test|spec)\/[\w/.-]+)/,
  );
  if (pathMatch) return `${pathMatch[1]}**`;

  // Try to extract just a directory reference
  const dirMatch = text.match(
    /\b((?:src|lib|app|components|utils|test|spec)\/[\w/-]*)/,
  );
  if (dirMatch) return `${dirMatch[1]}/**`;

  return null;
}

function inferFromGitOwnership(
  filePath: string,
  repoPath: string,
): ScopeInference | null {
  try {
    // Check CODEOWNERS
    const codeowners = execSync(
      `cat .github/CODEOWNERS 2>/dev/null || cat CODEOWNERS 2>/dev/null || echo ""`,
      { cwd: repoPath, encoding: "utf-8" },
    ).trim();

    if (codeowners) {
      // If the file matches a CODEOWNERS pattern, scope to that team
      const dir = dirname(filePath);
      for (const line of codeowners.split("\n")) {
        if (line.startsWith("#") || !line.trim()) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && filePath.includes(parts[0].replace("*", ""))) {
          return {
            scope: "path",
            path_scope: `${parts[0]}`,
            confidence_modifier: 0.05,
            reason: `CODEOWNERS match: ${parts[0]} → ${parts.slice(1).join(", ")}`,
          };
        }
      }
    }
  } catch {
    // No CODEOWNERS or git error
  }

  return null;
}

/**
 * Analyze a batch of corrections to find scope patterns.
 * If similar corrections keep appearing for the same directory,
 * suggest promoting to directory scope.
 */
export function analyzeScopePatterns(
  corrections: Array<{ text: string; path?: string; scope: MemoryScope }>,
): Array<{ suggested_scope: MemoryScope; path_scope: string | null; reason: string }> {
  const pathCounts = new Map<string, number>();

  for (const c of corrections) {
    if (c.path) {
      const dir = dirname(c.path);
      pathCounts.set(dir, (pathCounts.get(dir) ?? 0) + 1);
    }
  }

  const suggestions: Array<{
    suggested_scope: MemoryScope;
    path_scope: string | null;
    reason: string;
  }> = [];

  for (const [dir, count] of pathCounts) {
    if (count >= 3) {
      suggestions.push({
        suggested_scope: "path",
        path_scope: `${dir}/**`,
        reason: `${count} corrections in ${dir} — consider directory scope`,
      });
    }
  }

  // If most corrections are repo-scoped, suggest team scope
  const repoScoped = corrections.filter((c) => c.scope === "repo").length;
  if (repoScoped >= 5 && repoScoped / corrections.length > 0.8) {
    suggestions.push({
      suggested_scope: "team",
      path_scope: null,
      reason: `${repoScoped}/${corrections.length} corrections are repo-scoped — consider team scope`,
    });
  }

  return suggestions;
}
