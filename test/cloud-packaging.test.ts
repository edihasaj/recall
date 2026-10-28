import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveEngineFiles } from "../src/cloud/engine.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(root, "vendor", "recall-cloud-sync");

describe("cloud sync engine packaging", () => {
  it("is listed in the npm package files", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.files).toContain("vendor/recall-cloud-sync");
  });

  it("is copied into the app Runtime, creating the parent directory first", () => {
    const script = readFileSync(join(root, "scripts", "build-app.sh"), "utf8");
    const mkdir = script.indexOf('mkdir -p "$runtime_dir/vendor/recall-cloud-sync"');
    const rsync = script.indexOf('rsync -a "$root_dir/vendor/recall-cloud-sync/"');
    expect(mkdir).toBeGreaterThan(-1);
    expect(rsync).toBeGreaterThan(mkdir);
  });

  it("keeps the bundled snapshot identical to the hashes in PROVENANCE.md", () => {
    const provenance = readFileSync(join(vendor, "PROVENANCE.md"), "utf8");
    for (const file of ["recall-sync.mjs", "recall-sync-local.mjs", "private-token.mjs"]) {
      const hash = createHash("sha256").update(readFileSync(join(vendor, file))).digest("hex");
      expect(provenance, file).toContain(hash);
    }
  });

  it("is found from source and from a bundled dist layout", () => {
    const fromSource = resolveEngineFiles(pathToFileURL(join(root, "src", "cloud", "engine.ts")).href);
    expect(fromSource.engine).toBe(join(vendor, "recall-sync.mjs"));
    expect(fromSource.wrapper).toBe(join(vendor, "managed-worker.mjs"));
    expect(resolveEngineFiles(pathToFileURL(join(root, "dist", "daemon.js")).href).engine).toBe(join(vendor, "recall-sync.mjs"));
  });

  it("ships in the packed tarball", () => {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
    const files: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);
    for (const file of ["recall-sync.mjs", "recall-sync-local.mjs", "private-token.mjs", "managed-worker.mjs", "PROVENANCE.md"]) {
      expect(files).toContain(`vendor/recall-cloud-sync/${file}`);
    }
  }, 60_000);
});
