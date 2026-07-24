import { join } from "node:path";
import { createHooklessAdapter } from "./hookless.js";
import { opencodeEntry } from "./mcp-json.js";
import { buildRecallRulesBody } from "./rules-block.js";
import { resolveUserHomeDir } from "./utils.js";
import type { HomeDirOption } from "./types.js";

const LABEL = "opencode";

/** opencode keeps its global config under ~/.config/opencode regardless of XDG_CONFIG_HOME. */
export function opencodeConfigDir(options: HomeDirOption = {}): string {
  return join(options.homeDir ?? resolveUserHomeDir(), ".config", "opencode");
}

export function opencodeConfigPath(options: HomeDirOption = {}): string {
  return join(opencodeConfigDir(options), "opencode.json");
}

/**
 * Global instructions. Project-root AGENTS.md is shared with other tools, so
 * setup writes the user-global copy instead of editing a file the repo owns.
 */
export function opencodeAgentsPath(options: HomeDirOption = {}): string {
  return join(opencodeConfigDir(options), "AGENTS.md");
}

export const opencodeAdapter = createHooklessAdapter({
  name: "opencode",
  label: LABEL,
  commands: ["opencode"],
  markerPaths: (options) => [opencodeConfigDir(options)],
  mcpTarget: (options) => ({
    configPath: options.configPath ?? opencodeConfigPath(options),
    // opencode nests servers directly under "mcp", not "mcpServers".
    containerKey: "mcp",
    buildEntry: opencodeEntry,
  }),
  rulesPath: (options) => opencodeAgentsPath(options),
  rulesBlock: {
    name: "memory",
    version: 1,
    body: buildRecallRulesBody(LABEL),
  },
  rulesScope: "global",
});
