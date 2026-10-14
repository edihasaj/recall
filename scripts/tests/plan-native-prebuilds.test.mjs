import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { planPrebuilds, writePlan } from "../plan-native-prebuilds.mjs";

test("workflow wires the validated plan before allocating selected build runners", () => {
  const file = new URL("../../.github/workflows/native-prebuilds.yml", import.meta.url);
  const document = JSON.parse(execFileSync("ruby", ["-ryaml", "-rjson", "-e",
    "d=YAML.safe_load(File.read(ARGV[0]),aliases:true);d['on']=d.delete(true);puts JSON.generate(d)",
    file.pathname], { encoding: "utf8" }));
  const schema = document.on.workflow_dispatch.inputs;
  assert.equal(schema.node_versions.default, "22");
  assert.equal(schema.node_versions.type, "string");
  assert.equal(schema.platform.default, "linux");
  assert.equal(schema.architecture.default, "x64");
  assert.equal(schema.run_native.default, false);
  assert.equal(schema.dry_run.default, true);
  assert.equal(document.jobs.plan["runs-on"], "ubuntu-24.04");
  assert.equal(document.jobs.prebuild.needs, "plan");
  assert.equal(document.jobs.prebuild.strategy.matrix, "${{ fromJSON(needs.plan.outputs.matrix) }}");
  const step = document.jobs.plan.steps.find((item) => item.id === "plan");
  assert.deepEqual(step.env, {
    NODE_VERSIONS: "${{ inputs.node_versions }}",
    TARGET_PLATFORM: "${{ inputs.platform }}",
    TARGET_ARCHITECTURE: "${{ inputs.architecture }}",
  });
  assert.equal(step.run, "node scripts/plan-native-prebuilds.mjs");
});

test("defaults request one Linux Node 22 x64 job, never a Mac", () => {
  assert.deepEqual(planPrebuilds(), {
    include: [{ os: "linux", arch: "x64", runner: "ubuntu-22.04", node: 22 }],
  });
});

test("one Apple architecture and ABI allocate only one selected Mac", () => {
  assert.deepEqual(planPrebuilds({ platform: "macos", architecture: "arm64" }), {
    include: [{ os: "darwin", arch: "arm64", runner: "macos-14", node: 22 }],
  });
});

test("all supported targets remain available, but only through explicit selectors", () => {
  const rows = planPrebuilds({
    nodeVersions: "20,22,24", platform: "all", architecture: "all",
  }).include;
  assert.equal(rows.length, 18);
  assert.equal(rows.filter((row) => row.os === "darwin").length, 6);
  assert.equal(new Set(rows.map((row) => `${row.os}/${row.arch}/${row.node}`)).size, 18);
});

test("platform selection prevents Windows builds from ever using a Mac", () => {
  for (const platform of ["linux", "windows"]) {
    const rows = planPrebuilds({ platform, architecture: "all", nodeVersions: "22,24" }).include;
    assert.equal(rows.length, 4);
    assert.ok(rows.every((row) => !row.runner.startsWith("macos")));
  }
});

test("CSV selection is honored and duplicate ABIs cannot multiply spend", () => {
  const rows = planPrebuilds({ nodeVersions: "22, 24,22" }).include;
  assert.deepEqual(rows.map((row) => row.node), [22, 24]);
});

test("invalid selectors fail before writing matrix output", () => {
  for (const options of [
    { nodeVersions: "" }, { nodeVersions: "22," }, { nodeVersions: "26" },
    { nodeVersions: "22\nmatrix=untrusted" }, { nodeVersions: "22, $(touch injected)" },
    { nodeVersions: null }, { platform: "macos-latest" }, { architecture: "amd64" },
  ]) assert.throws(() => planPrebuilds(options));
  const dir = mkdtempSync(join(tmpdir(), "recall-prebuild-plan-"));
  try {
    const output = join(dir, "output");
    assert.throws(() => writePlan({ NODE_VERSIONS: "unsupported", GITHUB_OUTPUT: output }));
    assert.equal(existsSync(output), false);
    writePlan({ GITHUB_OUTPUT: output });
    const lines = readFileSync(output, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0].slice("matrix=".length)), planPrebuilds());
  } finally {
    rmSync(dir, { recursive: true, force: true }); // This test owns only its fixture.
  }
});
