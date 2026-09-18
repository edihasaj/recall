import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const serverPath = join(process.cwd(), "src", "mcp", "factory.ts");

describe("MCP query tool description", () => {
  it("requires retrieval when hook context is absent", () => {
    const source = readFileSync(serverPath, "utf-8");
    expect(source).toMatch(/If no relevant Recall context is visible/);
    expect(source).toMatch(/configured hooks are not proof/);
  });

  it("does not revert to the old primary-retrieval phrasing", () => {
    const source = readFileSync(serverPath, "utf-8");
    expect(source).not.toMatch(/^"Retrieve relevant memories for the current task context/m);
  });
});
