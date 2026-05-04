import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const serverPath = join(process.cwd(), "src", "mcp", "factory.ts");

describe("MCP query tool description", () => {
  it("frames query as a fallback and discourages default invocation", () => {
    const source = readFileSync(serverPath, "utf-8");
    expect(source).toMatch(/Fallback retrieval for repo memory/);
    expect(source).toMatch(/lifecycle hooks already inject/);
  });

  it("does not revert to the old primary-retrieval phrasing", () => {
    const source = readFileSync(serverPath, "utf-8");
    expect(source).not.toMatch(/^"Retrieve relevant memories for the current task context/m);
  });
});
