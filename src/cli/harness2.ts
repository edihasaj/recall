import type { Command } from "commander";
import { initDb } from "../db/client.js";
import {
  importHarness2Experience,
  readHarness2Experience,
} from "../importers/harness2.js";

export function registerHarness2Commands(program: Command) {
  const harness2 = program
    .command("harness2")
    .description("Import experimental Harness2 experience documents");

  harness2
    .command("import <file>")
    .description("Preview or import one Harness2 EXPERIENCE.md document")
    .requiredOption("--repo <slug>", "Repository slug for the candidate")
    .option("--source-ref <ref>", "Optional original Harness2 source reference")
    .option("--apply", "Write the candidate after previewing it")
    .option("--json", "Emit a cloud-import compatible JSON payload")
    .action((file: string, options: {
      repo: string;
      sourceRef?: string;
      apply?: boolean;
      json?: boolean;
    }) => {
      // Read and validate before touching the database. The default preview has
      // no migration, model, or network side effects.
      const preview = readHarness2Experience(file, {
        repo: options.repo,
        sourceRef: options.sourceRef,
      });
      const result = options.apply
        ? importHarness2Experience(initDb(), preview)
        : undefined;

      if (options.json) {
        console.log(JSON.stringify({
          applied: Boolean(options.apply),
          created: result?.created ?? false,
          preview,
          memory: result?.memory ?? null,
          cloudImport: preview.cloudImport,
        }, null, 2));
        return;
      }

      const memory = result?.memory;
      const verb = options.apply ? (result!.created ? "Imported" : "Already imported") : "Preview";
      console.log(`${verb} Harness2 candidate: ${memory?.id ?? preview.id}`);
      console.log(`  repo: ${memory?.repo ?? preview.project}`);
      console.log(`  digest: ${preview.digest}`);
      if (memory) {
        console.log(`  status: ${memory.status} (confidence ${memory.confidence.toFixed(2)}, auto-inject ${memory.auto_inject ? "on" : "off"})`);
      } else {
        console.log(`  status: preview candidate (confidence 0.40, auto-inject off)`);
      }
      console.log(`  content: ${preview.content.slice(0, 160)}${preview.content.length > 160 ? "…" : ""}`);
      if (!options.apply) {
        console.log(`\nTo import: recall harness2 import ${JSON.stringify(file)} --repo ${JSON.stringify(preview.project)} --apply`);
      }
      if (memory?.status === "candidate") {
        console.log(`To confirm after review: recall confirm ${memory.id}`);
      } else if (memory?.status === "rejected") {
        console.log(`This retained import is rejected. To review it again: recall reactivate ${memory.id}`);
      }
    });
}
