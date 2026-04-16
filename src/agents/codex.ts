import { existsSync } from "node:fs";
import { join } from "node:path";
import { hasCommand, resolveUserHomeDir } from "./utils.js";
import type { AgentAdapter, HookProfile, InstallResult } from "./types.js";

const configPath = () => join(resolveUserHomeDir(), ".codex", "config.toml");

export const codexAdapter: AgentAdapter = {
  name: "codex",
  configPath,
  detect() {
    return existsSync(configPath()) || hasCommand("codex") ? "installed" : "not-installed";
  },
  capabilities() {
    return {
      supports: ["prompt_submitted", "tool_invoked", "session_ended"],
      supports_hook_install: false,
      supports_mcp_fallback: true,
    };
  },
  installHooks(_profile: HookProfile): InstallResult {
    throw new Error("Codex hook installation not implemented yet.");
  },
  uninstallHooks(): InstallResult {
    throw new Error("Codex hook removal not implemented yet.");
  },
  envMapping: {},
  writeMcpFallback(): InstallResult {
    throw new Error("Codex MCP fallback wiring not implemented yet.");
  },
};
