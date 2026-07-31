import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultRecallAppPath, isDirectCliInvocation } from "../src/cli.js";

describe("npm CLI entrypoint", () => {
  it("uses the npm runtime layout on Linux", () => {
    expect(defaultRecallAppPath("linux")).toBeUndefined();
    expect(defaultRecallAppPath("darwin")).toBe("/Applications/Recall.app");
  });

  it("recognizes an npm bin symlink as the direct entrypoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-cli-link-"));
    const target = join(dir, "cli.js");
    const link = join(dir, "recall");
    writeFileSync(target, "");
    symlinkSync(target, link);
    expect(isDirectCliInvocation(pathToFileURL(target).href, link)).toBe(true);
  });
});
