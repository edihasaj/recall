import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Runs on the Unix release runner. Verify actual global npm resolution, not
// only manifest ranges. No install scripts run.
const archive = resolve(process.argv[2]);
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const prefix = mkdtempSync(join(tmpdir(), "recall-release-package-"));
try {
  execFileSync("npm", ["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", archive], {
    stdio: "inherit",
  });
  const installed = join(prefix, "lib", "node_modules", "@edihasaj", "recall");
  const dependencies = [...new Set([
    ...Object.keys(lock.packages[""].dependencies),
    ...Object.keys(lock.packages[""].optionalDependencies ?? {}),
    "onnxruntime-node",
  ])];
  for (const name of dependencies) {
    const actual = JSON.parse(readFileSync(join(installed, "node_modules", name, "package.json"), "utf8")).version;
    const expected = lock.packages[`node_modules/${name}`].version;
    assert.equal(actual, expected, `${name} drifted during global installation`);
    console.log(`${name}: ${actual} matches release lock`);
  }
} finally {
  rmSync(prefix, { recursive: true, force: true });
}
