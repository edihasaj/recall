import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("macOS app native runtime packaging", () => {
  it("rebuilds and loads ABI-bound modules with the embedded Node", () => {
    const script = readFileSync("scripts/build-app.sh", "utf8");

    expect(script).toContain('env PATH="$(dirname "$node_bin"):$PATH"');
    expect(script).toContain('"$node_bin" "$(command -v npm)" rebuild better-sqlite3');
    expect(script).toContain('"$runtime_dir/bin/node" -e');
    expect(script).toContain("new Database(':memory:')");
  });
});
