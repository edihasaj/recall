import { Command } from "commander";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { initDb } from "./db/client.js";
import {
  listMemories,
  getMemory,
  confirmMemory,
  rejectMemory,
  queryMemories,
  recordFeedback,
} from "./models/memory.js";
import { scanAndStore } from "./scanner/repo.js";
import { compileContext } from "./compiler/context.js";
import { processCorrection, processReviewFeedback } from "./capture/correction.js";
import { exportClaude, exportCodex, exportMarkdown } from "./adapters/markdown.js";

const program = new Command();

program
  .name("recall")
  .description("Cross-tool coding memory and instruction compiler")
  .version("0.1.0");

// --- init ---

program
  .command("init")
  .description("Initialize Recall database")
  .action(() => {
    initDb();
    console.log("Recall initialized. Database ready.");
  });

// --- scan ---

program
  .command("scan")
  .description("Scan a repository and bootstrap memories")
  .argument("[path]", "Repository path", ".")
  .action((path: string) => {
    const db = initDb();
    const repoPath = resolve(path);
    const ids = scanAndStore(db, repoPath);
    console.log(`Scanned ${repoPath}`);
    console.log(`Created ${ids.length} candidate memories.`);

    if (ids.length > 0) {
      console.log("\nMemories:");
      for (const id of ids) {
        const mem = getMemory(db, id);
        if (mem) {
          console.log(
            `  [${mem.status}] (${mem.confidence.toFixed(2)}) ${mem.type}: ${mem.text}`,
          );
        }
      }
      console.log(
        "\nUse `recall confirm <id>` to promote candidates, or `recall reject <id>` to discard.",
      );
    }
  });

// --- list ---

program
  .command("list")
  .description("List memories")
  .option("-r, --repo <repo>", "Filter by repository")
  .option(
    "-s, --status <status>",
    "Filter by status (transient|candidate|active|rejected)",
  )
  .option("-t, --type <type>", "Filter by type")
  .action((opts) => {
    const db = initDb();
    const items = queryMemories(db, {
      repo: opts.repo,
      status: opts.status,
      type: opts.type,
    });

    if (items.length === 0) {
      console.log("No memories found.");
      return;
    }

    for (const m of items) {
      const prefix = m.id.slice(0, 8);
      console.log(
        `${prefix}  [${m.status.padEnd(9)}] (${m.confidence.toFixed(2)}) ${m.type.padEnd(14)} ${m.text}`,
      );
    }
    console.log(`\n${items.length} memories total.`);
  });

// --- show ---

program
  .command("show")
  .description("Show memory details")
  .argument("<id>", "Memory ID (full or prefix)")
  .action((idPrefix: string) => {
    const db = initDb();
    const mem = findByPrefix(db, idPrefix);
    if (!mem) {
      console.error(`Memory not found: ${idPrefix}`);
      process.exit(1);
    }
    console.log(JSON.stringify(mem, null, 2));
  });

// --- confirm ---

program
  .command("confirm")
  .description("Confirm a memory (promote to active)")
  .argument("<id>", "Memory ID (full or prefix)")
  .action((idPrefix: string) => {
    const db = initDb();
    const mem = findByPrefix(db, idPrefix);
    if (!mem) {
      console.error(`Memory not found: ${idPrefix}`);
      process.exit(1);
    }
    const ok = confirmMemory(db, mem.id);
    if (ok) {
      console.log(`Confirmed: ${mem.id.slice(0, 8)} → active`);
    } else {
      console.error("Could not confirm (may be rejected).");
    }
  });

// --- reject ---

program
  .command("reject")
  .description("Reject a memory (never inject again)")
  .argument("<id>", "Memory ID (full or prefix)")
  .action((idPrefix: string) => {
    const db = initDb();
    const mem = findByPrefix(db, idPrefix);
    if (!mem) {
      console.error(`Memory not found: ${idPrefix}`);
      process.exit(1);
    }
    rejectMemory(db, mem.id);
    console.log(`Rejected: ${mem.id.slice(0, 8)}`);
  });

// --- compile ---

program
  .command("compile")
  .description("Compile active memories into injection pack")
  .requiredOption("-r, --repo <repo>", "Repository name")
  .option("-p, --path <path>", "File path for scoping")
  .option("--threshold <n>", "Confidence threshold", "0.6")
  .action((opts) => {
    const db = initDb();
    const result = compileContext(db, {
      repo: opts.repo,
      path: opts.path,
      config: { confidence_threshold: parseFloat(opts.threshold) },
    });

    if (!result.text) {
      console.log("No memories above threshold. Nothing to inject.");
      return;
    }

    console.log(result.text);
    console.log(`---`);
    console.log(
      `${result.memories_included.length} included, ${result.memories_dropped.length} dropped, ~${result.token_estimate} tokens`,
    );
  });

// --- correct ---

program
  .command("correct")
  .description("Report a correction to learn from")
  .argument("<text>", "Correction text")
  .option("-r, --repo <repo>", "Repository name")
  .option("-p, --path <path>", "File path context")
  .action((text: string, opts) => {
    const db = initDb();
    const ids = processCorrection(db, text, {
      sessionId: "cli",
      repo: opts.repo,
      path: opts.path,
    });

    if (ids.length === 0) {
      console.log("No correction pattern detected.");
      console.log(
        'Try: "don\'t use X, use Y" or "always do Z" or "review said to use W"',
      );
      return;
    }

    console.log(`Created ${ids.length} candidate(s):`);
    for (const id of ids) {
      const mem = getMemory(db, id);
      if (mem)
        console.log(`  ${id.slice(0, 8)}: ${mem.text}`);
    }
  });

// --- review ---

program
  .command("review")
  .description("Report review feedback")
  .argument("<feedback>", "Review feedback text")
  .option("-r, --repo <repo>", "Repository name")
  .option("-p, --path <path>", "File path context")
  .option("--reviewer <name>", "Reviewer name")
  .action((feedback: string, opts) => {
    const db = initDb();
    const ids = processReviewFeedback(db, feedback, {
      sessionId: "cli-review",
      repo: opts.repo,
      path: opts.path,
      reviewer: opts.reviewer,
    });

    console.log(`Created ${ids.length} candidate(s) from review feedback.`);
    for (const id of ids) {
      const mem = getMemory(db, id);
      if (mem) console.log(`  ${id.slice(0, 8)}: ${mem.text}`);
    }
  });

// --- export ---

program
  .command("export")
  .description("Export memories as markdown instruction files")
  .requiredOption("-r, --repo <repo>", "Repository name")
  .option(
    "-f, --format <format>",
    "Export format: claude | codex | markdown",
    "markdown",
  )
  .option("-o, --output <path>", "Output file path")
  .action((opts) => {
    const db = initDb();
    let content: string;

    switch (opts.format) {
      case "claude":
        content = exportClaude(db, opts.repo);
        break;
      case "codex":
        content = exportCodex(db, opts.repo);
        break;
      default:
        content = exportMarkdown(db, opts.repo);
    }

    if (opts.output) {
      writeFileSync(opts.output, content);
      console.log(`Exported to ${opts.output}`);
    } else {
      console.log(content);
    }
  });

// --- serve (MCP) ---

program
  .command("serve")
  .description("Start the MCP server (stdio transport)")
  .action(async () => {
    // Dynamic import to avoid loading MCP deps for other commands
    await import("./mcp/server.js");
  });

// --- Helpers ---

function findByPrefix(db: ReturnType<typeof initDb>, prefix: string) {
  // Try exact match first
  const exact = getMemory(db, prefix);
  if (exact) return exact;

  // Try prefix match
  const all = listMemories(db);
  const matches = all.filter((m) => m.id.startsWith(prefix));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.error(`Ambiguous prefix "${prefix}". Matches:`);
    for (const m of matches) console.error(`  ${m.id}`);
    process.exit(1);
  }
  return undefined;
}

program.parse();
