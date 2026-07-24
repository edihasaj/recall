import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { InstallResult } from "./types.js";

// Shared JSON MCP-registration helper.
//
// Copilot CLI, Cursor, Windsurf and opencode all register MCP servers by
// merging an entry into a JSON config file — same mechanic, three small
// dialect differences: the container key ("mcpServers" vs "mcp") and the
// shape of the entry itself (command+args vs a single command array).
// Each adapter describes its dialect via McpJsonTarget and shares the
// read -> merge -> backup -> atomic-write path implemented here.

export const RECALL_SERVER_KEY = "recall";

export interface McpServerSpec {
  /** Absolute path to the node binary that runs the MCP entrypoint. */
  nodePath: string;
  /** Absolute path to the Recall MCP entrypoint (dist/mcp.js). */
  mcpPath: string;
}

export interface McpJsonTarget {
  /** Absolute path to the JSON config file. */
  configPath: string;
  /** Top-level key holding the server map — "mcpServers" or "mcp". */
  containerKey: string;
  /** Entry name inside the container. Defaults to "recall". */
  serverKey?: string;
  /** Builds the dialect-specific server entry. */
  buildEntry(spec: McpServerSpec): Record<string, unknown>;
}

type JsonObject = Record<string, unknown>;

/** Entry shape used by Cursor and Windsurf (Claude Desktop dialect). */
export function commandArgsEntry(spec: McpServerSpec): JsonObject {
  return {
    command: spec.nodePath,
    args: [spec.mcpPath],
    env: {},
  };
}

/** Entry shape used by GitHub Copilot CLI — command/args plus type+tools. */
export function copilotEntry(spec: McpServerSpec): JsonObject {
  return {
    type: "local",
    command: spec.nodePath,
    args: [spec.mcpPath],
    env: {},
    tools: ["*"],
  };
}

/** Entry shape used by opencode — a single argv array under `command`. */
export function opencodeEntry(spec: McpServerSpec): JsonObject {
  return {
    type: "local",
    command: [spec.nodePath, spec.mcpPath],
    enabled: true,
  };
}

export function writeMcpServerEntry(
  target: McpJsonTarget,
  spec: McpServerSpec,
): InstallResult {
  const serverKey = target.serverKey ?? RECALL_SERVER_KEY;
  const read = readJsonConfig(target.configPath);
  if (read.error) {
    return { ok: false, changed: false, config_path: target.configPath, message: read.error };
  }

  const next = clone(read.parsed);
  const container = ensureContainer(next, target.containerKey);
  if (!container) {
    return {
      ok: false,
      changed: false,
      config_path: target.configPath,
      message: `"${target.containerKey}" in ${target.configPath} is not an object — leaving it alone`,
    };
  }

  const desired = target.buildEntry(spec);
  if (sameJson(container[serverKey], desired)) {
    return {
      ok: true,
      changed: false,
      config_path: target.configPath,
      message: `Recall MCP server already registered in ${target.configPath}`,
    };
  }

  container[serverKey] = desired;
  writeJsonConfig(target.configPath, read.raw, next);
  return {
    ok: true,
    changed: true,
    config_path: target.configPath,
    message: read.raw == null
      ? `Created ${target.configPath} with Recall MCP server`
      : `Registered Recall MCP server in ${target.configPath}`,
  };
}

export function removeMcpServerEntry(target: McpJsonTarget): InstallResult {
  const serverKey = target.serverKey ?? RECALL_SERVER_KEY;
  if (!existsSync(target.configPath)) {
    return {
      ok: true,
      changed: false,
      config_path: target.configPath,
      message: `${target.configPath} not found`,
    };
  }

  const read = readJsonConfig(target.configPath);
  if (read.error) {
    return { ok: false, changed: false, config_path: target.configPath, message: read.error };
  }

  const next = clone(read.parsed);
  const container = asObject(next[target.containerKey]);
  if (!container || !(serverKey in container)) {
    return {
      ok: true,
      changed: false,
      config_path: target.configPath,
      message: `No Recall MCP server registered in ${target.configPath}`,
    };
  }

  delete container[serverKey];
  // Drop the container entirely once we removed the last entry so we don't
  // leave an empty `mcpServers: {}` behind in a config we didn't create.
  if (Object.keys(container).length === 0) {
    delete next[target.containerKey];
  }

  writeJsonConfig(target.configPath, read.raw, next);
  return {
    ok: true,
    changed: true,
    config_path: target.configPath,
    message: `Removed Recall MCP server from ${target.configPath}`,
  };
}

export function hasMcpServerEntry(target: McpJsonTarget): boolean {
  if (!existsSync(target.configPath)) return false;
  const read = readJsonConfig(target.configPath);
  if (read.error) return false;
  const container = asObject(read.parsed[target.containerKey]);
  return Boolean(container && (target.serverKey ?? RECALL_SERVER_KEY) in container);
}

function readJsonConfig(configPath: string): {
  raw: string | null;
  parsed: JsonObject;
  error?: string;
} {
  if (!existsSync(configPath)) return { raw: null, parsed: {} };

  const raw = readFileSync(configPath, "utf-8");
  if (raw.trim().length === 0) return { raw, parsed: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Hand-edited configs (and opencode's .jsonc) may carry comments or a
    // trailing comma. Rewriting would drop the user's edits, so bail loudly
    // instead and let setup report it as a failed step.
    return {
      raw,
      parsed: {},
      error: `Could not parse ${configPath} as JSON — add the Recall MCP server manually`,
    };
  }

  const object = asObject(parsed);
  if (!object) {
    return { raw, parsed: {}, error: `${configPath} must contain a JSON object` };
  }
  return { raw, parsed: object };
}

function writeJsonConfig(configPath: string, previousRaw: string | null, value: unknown) {
  mkdirSync(dirname(configPath), { recursive: true });
  if (previousRaw != null) {
    writeFileSync(`${configPath}.recall.bak.${Date.now()}`, previousRaw);
  }
  const tmpPath = `${configPath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmpPath, configPath);
}

function ensureContainer(config: JsonObject, key: string): JsonObject | null {
  if (config[key] === undefined) {
    config[key] = {};
  }
  return asObject(config[key]);
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function clone(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
