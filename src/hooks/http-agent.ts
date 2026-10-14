import type { RecallDb } from "../db/client.js";
import {
  formatInjectionContext,
  formatMaintenanceBacklogContext,
  formatPendingConfirmationsContext,
  handlePromptHook,
  handleSessionEndHook,
  handleSessionStartHook,
  handleToolHook,
  type HookResult,
} from "../cli/hook.js";
import { toolOutcomeFromPayload } from "../feedback/tool-outcomes.js";

export const HTTP_HOOK_EVENTS = [
  "SessionStart", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd",
] as const;
export type HttpHookEvent = typeof HTTP_HOOK_EVENTS[number];
export type HttpHookAgent = "codex" | "claude-code";

function text(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export async function handleAgentHttpHook(
  db: RecallDb,
  agent: HttpHookAgent,
  event: HttpHookEvent,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const session = text(payload, "session_id");
  if (!session) throw new Error("session_id required");
  const common = { agent, session_id: session, repo: text(payload, "repo"), repo_path: text(payload, "cwd") };
  let result: HookResult;
  switch (event) {
    case "SessionStart":
      result = await handleSessionStartHook(common, { db, source: "daemon" });
      break;
    case "UserPromptSubmit": {
      const prompt = text(payload, "prompt") ?? text(payload, "user_prompt");
      if (!prompt) throw new Error("prompt required");
      result = await handlePromptHook({ ...common, text: prompt }, { db, source: "daemon" });
      break;
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      const name = text(payload, "tool_name");
      if (!name) throw new Error("tool_name required");
      const outcome = toolOutcomeFromPayload({ ...payload, hook_event_name: event });
      const input = payload.tool_input;
      const path = input && typeof input === "object" && !Array.isArray(input)
        ? text(input as Record<string, unknown>, "file_path")
          ?? text(input as Record<string, unknown>, "path")
        : undefined;
      result = await handleToolHook({
        ...common, ...outcome, name, path,
        input_summary: input ? JSON.stringify(input).slice(0, 1024) : undefined,
      }, { db, source: "daemon" });
      break;
    }
    case "Stop":
    case "SessionEnd":
      result = await handleSessionEndHook({
        ...common, last_assistant_turn: text(payload, "last_assistant_message"),
      }, { db, source: "daemon" });
      break;
  }
  if (event !== "SessionStart" && event !== "UserPromptSubmit") return {};
  const context = [
    result.injection ? formatInjectionContext(result.injection) : "",
    event === "SessionStart" && result.maintenance_backlog
      ? formatMaintenanceBacklogContext(result.maintenance_backlog) : "",
    event === "SessionStart" && result.pending_confirmations
      ? formatPendingConfirmationsContext(result.pending_confirmations) : "",
  ].filter(Boolean).join("\n\n");
  return context ? {
    hookSpecificOutput: { hookEventName: event, additionalContext: context },
  } : {};
}
