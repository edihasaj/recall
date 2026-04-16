import { existsSync } from "node:fs";
import { join } from "node:path";
import { hasCommand, resolveUserHomeDir } from "./utils.js";
import type { AgentAdapter, HookProfile, InstallResult } from "./types.js";

const configPath = () => join(resolveUserHomeDir(), ".claude", "settings.json");

export const claudeCodeAdapter: AgentAdapter = {
  name: "claude-code",
  configPath,
  detect() {
    return existsSync(configPath()) || hasCommand("claude") ? "installed" : "not-installed";
  },
  capabilities() {
    return {
      supports: ["session_started", "prompt_submitted", "tool_invoked", "session_ended"],
      supports_hook_install: false,
      supports_mcp_fallback: true,
    };
  },
  installHooks(_profile: HookProfile): InstallResult {
    throw new Error("Claude Code hook installation not implemented yet.");
  },
  uninstallHooks(): InstallResult {
    throw new Error("Claude Code hook removal not implemented yet.");
  },
  envMapping: {},
  writeMcpFallback(): InstallResult {
    throw new Error("Claude Code MCP fallback wiring not implemented yet.");
  },
};
