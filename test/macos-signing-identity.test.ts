import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve(process.cwd(), "scripts/sign-macos-nested.sh");

function runSigning(identifier: string) {
  const root = mkdtempSync(join(tmpdir(), "recall signing "));
  const app = join(root, "Recall Test.app");
  const node = join(app, "Contents", "Resources", "Runtime", "bin", "node");
  const bin = join(root, "mock bin");
  const log = join(root, "codesign.args");
  mkdirSync(join(app, "Contents", "Resources", "Runtime", "bin"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(node, "fixture");
  chmodSync(node, 0o755);
  writeFileSync(join(bin, "file"), "#!/bin/sh\nprintf 'Mach-O 64-bit executable\\n'\n");
  writeFileSync(join(bin, "codesign"), `#!/bin/sh
if [ "$1" = "--display" ]; then
  printf 'Identifier=%s\\n' "$MOCK_IDENTIFIER" >&2
  exit 0
fi
printf '%s\\0' "$@" >> "$MOCK_CODESIGN_LOG"
`);
  chmodSync(join(bin, "file"), 0o755);
  chmodSync(join(bin, "codesign"), 0o755);
  const result = spawnSync("bash", [script, app, "Developer ID Application: Test"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_IDENTIFIER: identifier, MOCK_CODESIGN_LOG: log },
  });
  return { result, calls: readFileSync(log).toString().split("\0").filter(Boolean) };
}

describe("macOS nested runtime signing", () => {
  it("signs bundled Node with its stable runtime identifier", () => {
    const { result, calls } = runSigning("com.edihasaj.recall.runtime.node");
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain("--identifier");
    expect(calls).toContain("com.edihasaj.recall.runtime.node");
    expect(calls).toContain("--entitlements");
    expect(calls).toContain("--options");
    expect(calls).toContain("runtime");
  });

  it("fails when codesign reports a different bundled Node identifier", () => {
    const { result } = runSigning("com.example.wrong");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Bundled Node identifier is not com.edihasaj.recall.runtime.node");
  });
});
