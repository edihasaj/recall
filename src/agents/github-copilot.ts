import { join } from "node:path";
import { createHooklessAdapter, projectPath } from "./hookless.js";
import { copilotEntry } from "./mcp-json.js";
import { buildRecallRulesBody } from "./rules-block.js";
import { resolveUserHomeDir } from "./utils.js";
import type { HomeDirOption } from "./types.js";

const LABEL = "GitHub Copilot";

/** Copilot CLI's config directory — relocatable via COPILOT_HOME. */
export function copilotHome(options: HomeDirOption = {}): string {
  if (options.homeDir) return join(options.homeDir, ".copilot");
  return process.env.COPILOT_HOME ?? join(resolveUserHomeDir(), ".copilot");
}

export function copilotMcpConfigPath(options: HomeDirOption = {}): string {
  return join(copilotHome(options), "mcp-config.json");
}

/**
 * Copilot reads repo instructions from `.github/copilot-instructions.md`, which
 * both the CLI and the VS Code extension pick up — there is no user-global
 * equivalent, so this block is project-scoped.
 */
export function copilotInstructionsPath(options: { cwd?: string } = {}): string {
  return projectPath(options, ".github", "copilot-instructions.md");
}

export const githubCopilotAdapter = createHooklessAdapter({
  name: "github-copilot",
  label: LABEL,
  commands: ["copilot"],
  markerPaths: (options) => [copilotHome(options)],
  mcpTarget: (options) => ({
    configPath: options.configPath ?? copilotMcpConfigPath(options),
    containerKey: "mcpServers",
    buildEntry: copilotEntry,
  }),
  rulesPath: (options) => copilotInstructionsPath(options),
  rulesBlock: {
    name: "memory",
    version: 1,
    body: buildRecallRulesBody(LABEL),
  },
  rulesScope: "project",
});
