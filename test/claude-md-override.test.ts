import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkClaudeCodeMemoryOverride,
  installClaudeCodeMemoryOverride,
  uninstallClaudeCodeMemoryOverride,
} from "../src/agents/claude-code.js";

function freshTarget() {
  const dir = mkdtempSync(join(tmpdir(), "recall-claude-md-"));
  return join(dir, "CLAUDE.md");
}

afterEach(() => {
  delete process.env.RECALL_SETUP_SKIP_CLAUDE_MD;
});

describe("installClaudeCodeMemoryOverride", () => {
  it("creates CLAUDE.md with the managed block when the file is missing", () => {
    const target = freshTarget();
    const result = installClaudeCodeMemoryOverride({ configPath: target });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    const content = readFileSync(target, "utf-8");
    expect(content).toContain("recall:managed:claude-md:begin");
    expect(content).toContain("recall:managed:claude-md:end");
    expect(content).toContain("Recall is the single source of truth");
  });

  it("appends the block to an existing file without touching prior content", () => {
    const target = freshTarget();
    writeFileSync(target, "# My existing CLAUDE.md\n\nSome user notes here.\n");
    installClaudeCodeMemoryOverride({ configPath: target });
    const content = readFileSync(target, "utf-8");
    expect(content).toContain("# My existing CLAUDE.md");
    expect(content).toContain("Some user notes here.");
    expect(content).toContain("recall:managed:claude-md:begin");
  });

  it("is idempotent — second install returns changed=false", () => {
    const target = freshTarget();
    installClaudeCodeMemoryOverride({ configPath: target });
    const before = readFileSync(target, "utf-8");
    const second = installClaudeCodeMemoryOverride({ configPath: target });
    expect(second.changed).toBe(false);
    expect(readFileSync(target, "utf-8")).toBe(before);
  });

  it("replaces an older managed block in place (handles version bumps)", () => {
    const target = freshTarget();
    // Simulate an older block from a previous Recall version.
    const oldBlock = "<!-- recall:managed:claude-md:begin -->\nold body\n<!-- recall:managed:claude-md:end -->\n";
    writeFileSync(target, `# User content\n\n${oldBlock}\n# More user content\n`);
    const result = installClaudeCodeMemoryOverride({ configPath: target });
    expect(result.changed).toBe(true);
    const content = readFileSync(target, "utf-8");
    expect(content).toContain("# User content");
    expect(content).toContain("# More user content");
    expect(content).not.toContain("old body");
    expect(content).toContain("Recall is the single source of truth");
    // Only one managed block remains.
    const beginCount = (content.match(/recall:managed:claude-md:begin/g) ?? []).length;
    expect(beginCount).toBe(1);
  });

  it("respects RECALL_SETUP_SKIP_CLAUDE_MD=1", () => {
    process.env.RECALL_SETUP_SKIP_CLAUDE_MD = "1";
    const target = freshTarget();
    const result = installClaudeCodeMemoryOverride({ configPath: target });
    expect(result.changed).toBe(false);
    expect(existsSync(target)).toBe(false);
  });
});

describe("uninstallClaudeCodeMemoryOverride", () => {
  it("removes only the managed block, preserving user content", () => {
    const target = freshTarget();
    writeFileSync(target, "# My CLAUDE.md\n\nUser stuff.\n");
    installClaudeCodeMemoryOverride({ configPath: target });
    const after = uninstallClaudeCodeMemoryOverride({ configPath: target });
    expect(after.changed).toBe(true);
    const content = readFileSync(target, "utf-8");
    expect(content).toContain("# My CLAUDE.md");
    expect(content).toContain("User stuff.");
    expect(content).not.toContain("recall:managed:claude-md");
  });

  it("is a no-op when no managed block exists", () => {
    const target = freshTarget();
    writeFileSync(target, "# Just user content\n");
    const result = uninstallClaudeCodeMemoryOverride({ configPath: target });
    expect(result.changed).toBe(false);
    expect(readFileSync(target, "utf-8")).toBe("# Just user content\n");
  });

  it("handles a missing file gracefully", () => {
    const target = freshTarget();
    const result = uninstallClaudeCodeMemoryOverride({ configPath: target });
    expect(result.changed).toBe(false);
    expect(existsSync(target)).toBe(false);
  });
});

describe("checkClaudeCodeMemoryOverride", () => {
  it("reports absent_no_file when nothing exists", () => {
    const target = freshTarget();
    const status = checkClaudeCodeMemoryOverride({ configPath: target });
    expect(status.status).toBe("absent_no_file");
  });

  it("reports missing when the file exists but has no block", () => {
    const target = freshTarget();
    writeFileSync(target, "# user content only\n");
    expect(checkClaudeCodeMemoryOverride({ configPath: target }).status).toBe("missing");
  });

  it("reports current after a fresh install", () => {
    const target = freshTarget();
    installClaudeCodeMemoryOverride({ configPath: target });
    expect(checkClaudeCodeMemoryOverride({ configPath: target }).status).toBe("current");
  });

  it("reports stale when the block is an older version", () => {
    const target = freshTarget();
    // Write an older-version begin marker so the begin-marker-name matches
    // but the current-version check fails.
    writeFileSync(
      target,
      "<!-- recall:managed:claude-md:begin v0 -->\nold body\n<!-- recall:managed:claude-md:end -->\n",
    );
    expect(checkClaudeCodeMemoryOverride({ configPath: target }).status).toBe("stale");
  });
});
