import { describe, expect, it } from "vitest";
import { resolveRuntimePaths, runLocalSetup } from "../src/setup/local.js";

describe("local setup helper", () => {
  it("derives bundled runtime paths from Recall.app", () => {
    const paths = resolveRuntimePaths("/Applications/Recall.app");
    expect(paths.runtimeNodePath).toBe("/Applications/Recall.app/Contents/Resources/Runtime/bin/node");
    expect(paths.runtimeCliPath).toBe("/Applications/Recall.app/Contents/Resources/Runtime/dist/cli.js");
    expect(paths.runtimeMcpPath).toBe("/Applications/Recall.app/Contents/Resources/Runtime/dist/mcp.js");
  });

  it("fails fast when the app is missing", () => {
    expect(() =>
      runLocalSetup({
        appPath: "/tmp/DefinitelyMissingRecall.app",
        codex: false,
        claude: false,
      })
    ).toThrow(/Recall\.app not found/);
  });
});
