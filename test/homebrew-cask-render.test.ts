import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const renderer = resolve(process.cwd(), "scripts/render-homebrew-cask.mjs");

describe("Homebrew cask renderer", () => {
  it("renders the canonical template with the bundled CLI artifact", () => {
    const output = execFileSync(process.execPath, [renderer], {
      env: {
        ...process.env,
        RECALL_RELEASE_TAG: "v9.8.7",
        RECALL_APP_ZIP_SHA256: "abc123",
        RECALL_GITHUB_REPO: "example/recall",
        RECALL_HOMEPAGE: "https://example.test/recall",
      },
      encoding: "utf8",
    });

    expect(output).toContain('version "9.8.7"');
    expect(output).toContain('sha256 "abc123"');
    expect(output).toContain("github.com/example/recall/releases/download/v#{version}");
    expect(output).toContain('homepage "https://example.test/recall"');
    expect(output).toContain('binary "#{appdir}/Recall.app/Contents/Resources/Runtime/bin/recall"');
    expect(output).not.toContain("REPLACE_WITH_RELEASE_SHA256");
  });
});
