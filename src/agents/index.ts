import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import type { AgentAdapter, AgentName } from "./types.js";

const adapters: Record<AgentName, AgentAdapter> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
};

export function listAgentNames(): AgentName[] {
  return Object.keys(adapters) as AgentName[];
}

export function listAdapters(): AgentAdapter[] {
  return listAgentNames().map((name) => adapters[name]);
}

export function resolveAdapter(name: string): AgentAdapter {
  const adapter = adapters[name as AgentName];
  if (adapter) {
    return adapter;
  }

  throw new Error(
    `Unknown agent adapter: ${name}. Supported adapters: ${listAgentNames().join(", ")}`,
  );
}

export function detectInstalledAdapters(): AgentAdapter[] {
  return listAdapters().filter((adapter) => adapter.detect() === "installed");
}

export * from "./types.js";
