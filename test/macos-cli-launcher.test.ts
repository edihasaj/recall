import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("bundled macOS CLI launcher", () => {
  it("resolves a Homebrew-style symlink and runs the bundled Node runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "recall-app-launcher-"));
    const runtime = join(root, "Recall.app", "Contents", "Resources", "Runtime");
    const launcher = join(runtime, "bin", "recall");
    const cli = join(runtime, "dist", "cli.js");
    const linkedLauncher = join(root, "homebrew", "bin", "recall");

    mkdirSync(dirname(launcher), { recursive: true });
    mkdirSync(dirname(cli), { recursive: true });
    mkdirSync(dirname(linkedLauncher), { recursive: true });
    copyFileSync(join(process.cwd(), "scripts", "recall-app"), launcher);
    chmodSync(launcher, 0o755);
    writeFileSync(
      join(runtime, "bin", "node"),
      "#!/bin/sh\nprintf '%s\\n' \"$@\"\n",
    );
    chmodSync(join(runtime, "bin", "node"), 0o755);
    writeFileSync(cli, "");
    symlinkSync(launcher, linkedLauncher);

    const output = execFileSync(linkedLauncher, ["doctor", "--fix"], { encoding: "utf8" });
    expect(output.trim().split("\n")).toEqual([cli, "doctor", "--fix"]);
  });
});
