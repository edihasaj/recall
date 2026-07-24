import { join } from "node:path";
import { createHooklessAdapter } from "./hookless.js";
import { commandArgsEntry } from "./mcp-json.js";
import { buildRecallRulesBody } from "./rules-block.js";
import { resolveUserHomeDir } from "./utils.js";
import type { HomeDirOption } from "./types.js";

const LABEL = "Windsurf";

export function windsurfConfigDir(options: HomeDirOption = {}): string {
  return join(options.homeDir ?? resolveUserHomeDir(), ".codeium", "windsurf");
}

export function windsurfMcpConfigPath(options: HomeDirOption = {}): string {
  return join(windsurfConfigDir(options), "mcp_config.json");
}

/** Cascade's user-global rules file — applied across every workspace. */
export function windsurfGlobalRulesPath(options: HomeDirOption = {}): string {
  return join(windsurfConfigDir(options), "memories", "global_rules.md");
}

export const windsurfAdapter = createHooklessAdapter({
  name: "windsurf",
  label: LABEL,
  commands: ["windsurf"],
  markerPaths: (options) => [windsurfConfigDir(options)],
  mcpTarget: (options) => ({
    configPath: options.configPath ?? windsurfMcpConfigPath(options),
    containerKey: "mcpServers",
    buildEntry: commandArgsEntry,
  }),
  rulesPath: (options) => windsurfGlobalRulesPath(options),
  rulesBlock: {
    name: "memory",
    version: 1,
    body: buildRecallRulesBody(LABEL),
  },
  rulesScope: "global",
});
