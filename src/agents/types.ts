export const canonicalEventNames = [
  "session_started",
  "prompt_submitted",
  "tool_invoked",
  "session_ended",
] as const;

export type CanonicalEventName = (typeof canonicalEventNames)[number];

export const hookProfileV1 = [
  "prompt_submitted",
  "tool_invoked",
  "session_ended",
] as const;

export type HookProfile = readonly CanonicalEventName[];
export type AgentName =
  | "claude-code"
  | "codex"
  | "gemini-cli"
  | "qwen"
  | "github-copilot"
  | "opencode"
  | "cursor"
  | "windsurf";
export type AdapterDetection = "installed" | "not-installed";
export type SetupScope = "global" | "project";

export interface RecentToolCall {
  name: string;
  path?: string;
  input_summary?: string;
  exit_code?: number;
}

interface CanonicalEventContext {
  repo?: string;
  session_id: string;
}

export interface SessionStartedEvent extends CanonicalEventContext {
  type: "session_started";
  agent: AgentName;
  started_at: string;
}

export interface PromptSubmittedEvent extends CanonicalEventContext {
  type: "prompt_submitted";
  text: string;
  prev_assistant_turn?: string;
  recent_tool_calls?: readonly RecentToolCall[];
}

export interface ToolInvokedEvent extends CanonicalEventContext {
  type: "tool_invoked";
  name: string;
  input_summary?: string;
  exit_code: number;
}

export interface SessionEndedEvent extends CanonicalEventContext {
  type: "session_ended";
  ended_at: string;
  turn_count: number;
}

export type CanonicalEvent =
  | SessionStartedEvent
  | PromptSubmittedEvent
  | ToolInvokedEvent
  | SessionEndedEvent;

export type EnvShape = Readonly<Record<string, string>>;

export interface AdapterCapabilities {
  supports: readonly CanonicalEventName[];
  supports_hook_install: boolean;
  supports_mcp_fallback: boolean;
}

export interface InstallResult {
  ok: boolean;
  changed: boolean;
  config_path: string | null;
  message: string;
}

/** Status of a Recall-managed block inside an agent's rules/instructions file. */
export type RulesStatus = "missing" | "current" | "stale" | "absent_no_file";

/** Overrides the user home used to resolve an agent's config paths. Mainly for tests and `recall doctor`. */
export interface HomeDirOption {
  homeDir?: string;
}

export interface McpFallbackOptions extends HomeDirOption {
  /** Absolute path to the node binary that launches the MCP entrypoint. */
  nodePath?: string;
  /** Absolute path to the Recall MCP entrypoint (dist/mcp.js). */
  mcpPath?: string;
  /** Override the JSON config file that receives the server entry. */
  configPath?: string;
  /** Global (user) config vs project-local config, where the agent supports both. */
  scope?: SetupScope;
  /** Project root used to resolve project-scoped configs. Defaults to process.cwd(). */
  cwd?: string;
}

export interface RulesInstallOptions extends HomeDirOption {
  /** Override the rules/instructions file path. */
  configPath?: string;
  /** Project root used to resolve project-scoped rules files. Defaults to process.cwd(). */
  cwd?: string;
}

export interface AgentAdapter {
  name: AgentName;
  configPath(options?: HomeDirOption): string;
  detect(options?: HomeDirOption): AdapterDetection;
  capabilities(): AdapterCapabilities;
  installHooks(profile: HookProfile): InstallResult;
  uninstallHooks(): InstallResult;
  envMapping: Partial<Record<CanonicalEventName, EnvShape>>;
  writeMcpFallback(options?: McpFallbackOptions): InstallResult;
  /** Undo writeMcpFallback. Only implemented by adapters that register via a JSON config. */
  removeMcpFallback?(options?: McpFallbackOptions): InstallResult;
  /** Whether the Recall MCP server is currently registered in the agent's config. */
  hasMcpRegistration?(options?: McpFallbackOptions): boolean;
  /**
   * Hookless agents route memory through a rules/instructions file instead of
   * lifecycle hooks. Implemented only by adapters where that applies.
   */
  installRules?(options?: RulesInstallOptions): InstallResult;
  uninstallRules?(options?: RulesInstallOptions): InstallResult;
  checkRules?(options?: RulesInstallOptions): { status: RulesStatus; config_path: string };
  /** Whether the rules file is user-global or lives inside the project. */
  rulesScope?: SetupScope;
}
