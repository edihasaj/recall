import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  hasMcpServerEntry,
  removeMcpServerEntry,
  writeMcpServerEntry,
  type McpJsonTarget,
  type McpServerSpec,
} from "./mcp-json.js";
import {
  checkManagedRules,
  installManagedRules,
  uninstallManagedRules,
  type ManagedRulesBlock,
} from "./rules-block.js";
import { hasCommand } from "./utils.js";
import type {
  AgentAdapter,
  AgentName,
  AdapterCapabilities,
  HomeDirOption,
  HookProfile,
  InstallResult,
  McpFallbackOptions,
  RulesInstallOptions,
  SetupScope,
} from "./types.js";

// Adapter factory for agents that expose no lifecycle-hook API.
//
// Copilot, Cursor, Windsurf and opencode can't call us on prompt/tool/session
// events, so Recall integrates with them the only way they allow: register the
// MCP server in their JSON config, and inject a rules block telling the model
// to drive capture/query itself. Everything except the config dialect and the
// file paths is identical, so it lives here once.

export interface HooklessAdapterSpec {
  name: AgentName;
  /** Human-readable product name used in messages and the rules body. */
  label: string;
  /** Executables that indicate the agent is installed. */
  commands?: readonly string[];
  /** Paths that indicate the agent is installed. */
  markerPaths?: (options: HomeDirOption) => readonly string[];
  /** Resolves the JSON config that receives the MCP server entry. */
  mcpTarget: (options: McpFallbackOptions) => McpJsonTarget;
  /** Resolves the rules/instructions file. */
  rulesPath: (options: RulesInstallOptions) => string;
  /** The managed block written into that file. */
  rulesBlock: ManagedRulesBlock;
  /** Whether the rules file is user-global or project-local. */
  rulesScope: SetupScope;
}

export function createHooklessAdapter(spec: HooklessAdapterSpec): AgentAdapter {
  const configPath = (options: HomeDirOption = {}) => spec.mcpTarget(options).configPath;

  return {
    name: spec.name,
    configPath,
    detect(options: HomeDirOption = {}) {
      const byCommand = (spec.commands ?? []).some((command) => hasCommand(command));
      const byPath = (spec.markerPaths?.(options) ?? []).some((path) => existsSync(path));
      return byCommand || byPath ? "installed" : "not-installed";
    },
    capabilities(): AdapterCapabilities {
      return {
        // No hook API: nothing observes prompts, tools or session lifecycle.
        supports: [],
        supports_hook_install: false,
        supports_mcp_fallback: true,
      };
    },
    installHooks(_profile: HookProfile): InstallResult {
      return {
        ok: false,
        changed: false,
        config_path: null,
        message: `${spec.label} exposes no hook API — use writeMcpFallback() and installRules() instead`,
      };
    },
    uninstallHooks(): InstallResult {
      return {
        ok: true,
        changed: false,
        config_path: null,
        message: `${spec.label} has no Recall-managed hooks`,
      };
    },
    envMapping: {},
    writeMcpFallback(options: McpFallbackOptions = {}): InstallResult {
      const serverSpec = resolveServerSpec(options, spec.label);
      if ("error" in serverSpec) {
        return { ok: false, changed: false, config_path: null, message: serverSpec.error };
      }
      return writeMcpServerEntry(spec.mcpTarget(options), serverSpec);
    },
    removeMcpFallback(options: McpFallbackOptions = {}): InstallResult {
      return removeMcpServerEntry(spec.mcpTarget(options));
    },
    hasMcpRegistration(options: McpFallbackOptions = {}): boolean {
      return hasMcpServerEntry(spec.mcpTarget(options));
    },
    installRules(options: RulesInstallOptions = {}): InstallResult {
      return installManagedRules(rulesTarget(spec, options), spec.rulesBlock);
    },
    uninstallRules(options: RulesInstallOptions = {}): InstallResult {
      return uninstallManagedRules(rulesTarget(spec, options), spec.rulesBlock);
    },
    checkRules(options: RulesInstallOptions = {}) {
      return checkManagedRules(rulesTarget(spec, options), spec.rulesBlock);
    },
    rulesScope: spec.rulesScope,
  };
}

function rulesTarget(spec: HooklessAdapterSpec, options: RulesInstallOptions): string {
  return options.configPath ?? spec.rulesPath(options);
}

function resolveServerSpec(
  options: McpFallbackOptions,
  label: string,
): McpServerSpec | { error: string } {
  const nodePath = options.nodePath ?? process.env.RECALL_NODE_PATH ?? process.execPath;
  const mcpPath = options.mcpPath ?? process.env.RECALL_MCP_PATH;
  if (!mcpPath) {
    return {
      error: `Unable to resolve the Recall MCP entrypoint for ${label} — pass mcpPath or set RECALL_MCP_PATH`,
    };
  }
  return { nodePath, mcpPath };
}

/** Resolve a project-relative path against the caller's cwd. */
export function projectPath(options: { cwd?: string }, ...segments: string[]): string {
  return resolve(options.cwd ?? process.cwd(), ...segments);
}
