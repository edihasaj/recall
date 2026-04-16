import type { AgentAdapter, HookProfile, InstallResult } from "./types.js";

export const geminiCliAdapter: AgentAdapter = {
  name: "gemini-cli",
  configPath() {
    return "";
  },
  detect() {
    return "not-installed";
  },
  capabilities() {
    return {
      supports: ["prompt_submitted", "tool_invoked", "session_ended"],
      supports_hook_install: false,
      supports_mcp_fallback: true,
    };
  },
  installHooks(_profile: HookProfile): InstallResult {
    throw new Error("Gemini CLI hook installation not implemented yet.");
  },
  uninstallHooks(): InstallResult {
    throw new Error("Gemini CLI hook removal not implemented yet.");
  },
  envMapping: {
    prompt_submitted: {
      prompt: "text",
      session_id: "session_id",
    },
    tool_invoked: {
      tool_name: "name",
      session_id: "session_id",
    },
    session_ended: {
      session_id: "session_id",
      reason: "reason",
    },
  },
  writeMcpFallback(): InstallResult {
    throw new Error("Gemini CLI MCP fallback wiring not implemented yet.");
  },
};
