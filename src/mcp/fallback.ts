import type { RecallDb } from "../db/client.js";
import { processCorrection } from "../capture/correction.js";
import { recordFeedback, getMemory } from "../models/memory.js";
import { createActivityEvent } from "../models/activity.js";
import { endSessionLifecycle } from "../session/lifecycle.js";
import type { ActivitySource, FeedbackOutcome } from "../types.js";
import type { RecentToolCall } from "../agents/types.js";
import { resolveMemoryInjectionOutcome } from "../models/memory-injections.js";

export interface CaptureCorrectionInput {
  text: string;
  repo?: string;
  path?: string;
  session_id?: string;
  agent?: string;
  prev_assistant_turn?: string;
  recent_tool_calls?: readonly RecentToolCall[];
}

export interface CaptureCorrectionResult {
  ids: string[];
  session_id: string;
}

export interface SignalOutcomeInput {
  memory_id: string;
  session_id: string;
  injected?: boolean;
  outcome: FeedbackOutcome;
  context?: string;
}

export interface SignalOutcomeResult {
  feedback_id: string;
}

export interface SessionEndInput {
  session_id: string;
  repo?: string;
  repo_path?: string;
  path?: string;
  agent?: string;
  turn_count?: number;
}

export interface SessionEndResult {
  session_id: string;
  repo: string | null;
}

export async function captureCorrectionFallback(
  db: RecallDb,
  input: CaptureCorrectionInput,
  source: ActivitySource,
): Promise<CaptureCorrectionResult> {
  const sessionId = input.session_id ?? `${source}-capture`;
  const ids = await processCorrection(db, input.text, {
    sessionId,
    repo: input.repo,
    path: input.path,
    agent: input.agent,
    prev_assistant_turn: input.prev_assistant_turn,
    recent_tool_calls: input.recent_tool_calls,
  });

  createActivityEvent(db, {
    session_id: sessionId,
    repo: input.repo ?? null,
    path: input.path ?? null,
    source,
    event_type: "correction",
    memory_ids: ids,
    request: {
      agent: input.agent ?? null,
      prev_assistant_turn: input.prev_assistant_turn ?? null,
      recent_tool_calls: normalizeRecentToolCalls(input.recent_tool_calls),
      text: input.text,
    },
    result: {
      created: ids,
      created_count: ids.length,
    },
  });

  return {
    ids,
    session_id: sessionId,
  };
}

export function signalOutcomeFallback(
  db: RecallDb,
  input: SignalOutcomeInput,
  source: ActivitySource,
): SignalOutcomeResult {
  const feedbackId = recordFeedback(
    db,
    input.memory_id,
    input.session_id,
    input.injected ?? true,
    input.outcome,
  );
  resolveMemoryInjectionOutcome(db, input.memory_id, input.session_id, input.outcome);
  const memory = getMemory(db, input.memory_id);

  createActivityEvent(db, {
    session_id: input.session_id,
    repo: memory?.repo ?? null,
    path: memory?.path_scope ?? null,
    source,
    event_type: "feedback",
    memory_ids: [input.memory_id],
    request: {
      context: input.context ?? null,
      injected: input.injected ?? true,
      outcome: input.outcome,
    },
    result: {
      feedback_id: feedbackId,
    },
  });

  return {
    feedback_id: feedbackId,
  };
}

export function sessionEndFallback(
  db: RecallDb,
  input: SessionEndInput,
): SessionEndResult {
  const result = endSessionLifecycle(db, {
    session_id: input.session_id,
    client: input.agent ?? "mcp",
    repo: input.repo ?? null,
    repo_path: input.repo_path ?? null,
    path: input.path ?? null,
    payload: {
      ended_at: new Date().toISOString(),
      turn_count: input.turn_count ?? null,
    },
  });

  return {
    session_id: result.session_id,
    repo: result.repo,
  };
}

function normalizeRecentToolCalls(
  toolCalls: readonly RecentToolCall[] | undefined,
): RecentToolCall[] {
  if (!toolCalls) return [];
  return toolCalls.map((toolCall) => ({
    name: toolCall.name,
    path: toolCall.path,
    input_summary: toolCall.input_summary,
    exit_code: toolCall.exit_code,
  }));
}
