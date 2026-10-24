import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Runs on the Unix release runner. Verify actual global npm resolution, not
// only manifest ranges. No install scripts run.
const archive = resolve(process.argv[2]);
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(lock.packages[""].version, manifest.version, "Release version differs from the lock");
assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies, "Runtime manifest differs from the lock");
assert.deepEqual(lock.packages[""].optionalDependencies, manifest.optionalDependencies, "Optional runtime manifest differs from the lock");

function installedPackages(directory, packages = new Map()) {
  if (!existsSync(directory)) return packages;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    assert(entry.isDirectory(), `Unexpected non-directory dependency: ${entry.name}`);
    const path = join(directory, entry.name);
    if (entry.name.startsWith("@")) {
      installedPackages(path, packages);
      continue;
    }
    const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    assert(typeof pkg.name === "string" && typeof pkg.version === "string", "Invalid installed package metadata");
    const versions = packages.get(pkg.name) ?? new Set();
    versions.add(pkg.version);
    packages.set(pkg.name, versions);
    installedPackages(join(path, "node_modules"), packages);
  }
  return packages;
}

const prefix = mkdtempSync(join(tmpdir(), "recall-release-package-"));
try {
  execFileSync("npm", ["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", archive], {
    stdio: "inherit",
  });
  const installed = join(prefix, "lib", "node_modules", "@edihasaj", "recall");
  assert.equal(
    readFileSync(join(installed, "scripts", "install.ps1"), "utf8"),
    readFileSync("scripts/install.ps1", "utf8"),
    "Windows updater script is missing from the published package",
  );
  for (const file of readdirSync("vendor/recall-cloud-sync")) {
    assert.equal(
      readFileSync(join(installed, "vendor", "recall-cloud-sync", file), "utf8"),
      readFileSync(join("vendor", "recall-cloud-sync", file), "utf8"),
      `Cloud sync engine file ${file} is missing or differs in the published package`,
    );
  }
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
  const packages = installedPackages(join(installed, "node_modules"));
  // Consumer npm installs ignore overrides inside dependencies. Check every
  // installed copy of security-sensitive packages before auditing the graph.
  for (const name of ["adm-zip", "sharp", "body-parser", "zod"]) {
    assert.deepEqual([...packages.get(name) ?? []], [lock.packages[`node_modules/${name}`].version],
      `${name} drifted in the published dependency graph`);
  }
  const response = await fetch("https://registry.npmjs.org/-/npm/v1/security/advisories/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(Object.fromEntries([...packages].map(([name, versions]) => [name, [...versions]]))),
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `Published dependency audit failed: HTTP ${response.status}`);
  const advisories = await response.json();
  assert(advisories && typeof advisories === "object" && !Array.isArray(advisories), "Invalid audit response");
  assert.deepEqual(Object.keys(advisories), [], `Published dependencies have advisories: ${Object.keys(advisories).join(", ")}`);
  console.log(`Audited ${packages.size} installed runtime packages: zero advisories`);
} finally {
  rmSync(prefix, { recursive: true, force: true });
}
