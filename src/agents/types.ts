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
export type AgentName = "claude-code" | "codex" | "gemini-cli" | "qwen";
export type AdapterDetection = "installed" | "not-installed";

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

export interface AgentAdapter {
  name: AgentName;
  configPath(): string;
  detect(): AdapterDetection;
  capabilities(): AdapterCapabilities;
  installHooks(profile: HookProfile): InstallResult;
  uninstallHooks(): InstallResult;
  envMapping: Partial<Record<CanonicalEventName, EnvShape>>;
  writeMcpFallback(): InstallResult;
}
