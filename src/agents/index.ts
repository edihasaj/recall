import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { geminiCliAdapter } from "./gemini-cli.js";
import { githubCopilotAdapter } from "./github-copilot.js";
import { opencodeAdapter } from "./opencode.js";
import { qwenAdapter } from "./qwen.js";
import { windsurfAdapter } from "./windsurf.js";
import type { AgentAdapter, AgentName } from "./types.js";

const adapters: Record<AgentName, AgentAdapter> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  "github-copilot": githubCopilotAdapter,
  opencode: opencodeAdapter,
  cursor: cursorAdapter,
  windsurf: windsurfAdapter,
  "gemini-cli": geminiCliAdapter,
  qwen: qwenAdapter,
};

/** Adapters that integrate through MCP + a rules file rather than lifecycle hooks. */
const hooklessAgents: readonly AgentName[] = [
  "github-copilot",
  "opencode",
  "cursor",
  "windsurf",
];

export function listAgentNames(): AgentName[] {
  return Object.keys(adapters) as AgentName[];
}

export function listAdapters(): AgentAdapter[] {
  return listAgentNames().map((name) => adapters[name]);
}

export function isHooklessAgent(name: AgentName): boolean {
  return hooklessAgents.includes(name);
}

export function resolveAdapter(name: string): AgentAdapter {
  const adapter = adapters[name as AgentName];
  if (adapter) {
    return adapter;
  }

  throw new Error(
    `Unknown agent adapter: ${name}. Supported adapters: ${listAgentNames().join(", ")}. Reserved v2 stubs: gemini-cli, qwen.`,
  );
}

export function detectInstalledAdapters(): AgentAdapter[] {
  return listAdapters().filter((adapter) => adapter.detect() === "installed");
}

export * from "./types.js";
