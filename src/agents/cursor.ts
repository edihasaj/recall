import { join } from "node:path";
import { createHooklessAdapter, projectPath } from "./hookless.js";
import { commandArgsEntry } from "./mcp-json.js";
import { buildRecallRulesBody } from "./rules-block.js";
import { resolveUserHomeDir } from "./utils.js";
import type { HomeDirOption } from "./types.js";

const LABEL = "Cursor";

export function cursorHome(options: HomeDirOption = {}): string {
  return join(options.homeDir ?? resolveUserHomeDir(), ".cursor");
}

export function cursorGlobalMcpPath(options: HomeDirOption = {}): string {
  return join(cursorHome(options), "mcp.json");
}

export function cursorProjectMcpPath(options: { cwd?: string } = {}): string {
  return projectPath(options, ".cursor", "mcp.json");
}

/**
 * Cursor loads project rules from `.cursor/rules/*.mdc`. Recall owns this file
 * outright, so it carries the frontmatter Cursor needs to always apply it.
 */
export function cursorRulesPath(options: { cwd?: string } = {}): string {
  return projectPath(options, ".cursor", "rules", "recall.mdc");
}

const CURSOR_MDC_FRONTMATTER = `---
description: Route durable memory through the Recall MCP server
alwaysApply: true
---

`;

export const cursorAdapter = createHooklessAdapter({
  name: "cursor",
  label: LABEL,
  commands: ["cursor"],
  markerPaths: (options) => [cursorHome(options)],
  mcpTarget: (options) => ({
    configPath: options.configPath
      ?? (options.scope === "project" ? cursorProjectMcpPath(options) : cursorGlobalMcpPath(options)),
    containerKey: "mcpServers",
    buildEntry: commandArgsEntry,
  }),
  rulesPath: (options) => cursorRulesPath(options),
  rulesBlock: {
    name: "memory",
    version: 1,
    body: buildRecallRulesBody(LABEL),
    ownsFile: true,
    preamble: CURSOR_MDC_FRONTMATTER,
  },
  rulesScope: "project",
});
