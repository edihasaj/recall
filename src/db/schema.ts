import { sqliteTable, text, integer, real, blob, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  type: text("type", {
    enum: ["rule", "command", "gotcha", "decision", "review_pattern"],
  }).notNull(),
  text: text("text").notNull(),
  scope: text("scope", {
    enum: ["session", "path", "repo", "team"],
  }).notNull(),
  path_scope: text("path_scope"),
  repo: text("repo"),
  status: text("status", {
    enum: ["transient", "candidate", "active", "rejected"],
  }).notNull(),
  confidence: real("confidence").notNull().default(0),
  source: text("source", {
    enum: [
      "user_correction",
      "user_reported_review",
      "repo_scan",
      "config_parse",
    ],
  }).notNull(),
  evidence: text("evidence", { mode: "json" }).notNull().default("[]"),
  capture_context: text("capture_context", { mode: "json" }),
  supersedes: text("supersedes"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
  last_validated_at: text("last_validated_at"),
  last_injected_at: text("last_injected_at"),
  injection_count: integer("injection_count").notNull().default(0),
  override_count: integer("override_count").notNull().default(0),
  repetition_count: integer("repetition_count").notNull().default(0),
  // Phase 2: sync + embeddings
  team_id: text("team_id"),
  sync_version: integer("sync_version").notNull().default(0),
}, (table) => ([
  index("idx_memories_repo").on(table.repo),
  index("idx_memories_status").on(table.status),
  index("idx_memories_repo_status").on(table.repo, table.status),
  index("idx_memories_team").on(table.team_id),
]));

export const memoryEmbeddings = sqliteTable("memory_embeddings", {
  memory_id: text("memory_id")
    .primaryKey()
    .references(() => memories.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  embedding_dimensions: integer("embedding_dimensions").notNull(),
  index_dimensions: integer("index_dimensions").notNull(),
  version: text("version").notNull(),
  content_hash: text("content_hash").notNull(),
  updated_at: text("updated_at").notNull(),
  embedding: blob("embedding", { mode: "buffer" }).notNull(),
}, (table) => ([
  index("idx_memory_embeddings_model").on(table.model),
  index("idx_memory_embeddings_updated").on(table.updated_at),
]));

export const historySnippets = sqliteTable("history_snippets", {
  id: text("id").primaryKey(),
  repo: text("repo"),
  session_id: text("session_id"),
  kind: text("kind", {
    enum: ["session_summary", "correction_summary", "review_summary", "compile_summary", "repo_synthesis"],
  }).notNull(),
  text: text("text").notNull(),
  source_activity_ids: text("source_activity_ids", { mode: "json" }).notNull().default("[]"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
}, (table) => ([
  index("idx_history_repo").on(table.repo),
  index("idx_history_session").on(table.session_id),
  index("idx_history_kind").on(table.kind),
  index("idx_history_created").on(table.created_at),
]));

export const historySnippetEmbeddings = sqliteTable("history_snippet_embeddings", {
  snippet_id: text("snippet_id")
    .primaryKey()
    .references(() => historySnippets.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  embedding_dimensions: integer("embedding_dimensions").notNull(),
  index_dimensions: integer("index_dimensions").notNull(),
  version: text("version").notNull(),
  content_hash: text("content_hash").notNull(),
  updated_at: text("updated_at").notNull(),
  embedding: blob("embedding", { mode: "buffer" }).notNull(),
}, (table) => ([
  index("idx_history_embeddings_model").on(table.model),
  index("idx_history_embeddings_updated").on(table.updated_at),
]));

export const feedbackEvents = sqliteTable("feedback_events", {
  id: text("id").primaryKey(),
  memory_id: text("memory_id")
    .notNull()
    .references(() => memories.id),
  session_id: text("session_id").notNull(),
  injected: integer("injected", { mode: "boolean" }).notNull(),
  outcome: text("outcome", {
    enum: ["followed", "overridden", "ignored", "contradicted"],
  }).notNull(),
  timestamp: text("timestamp").notNull(),
}, (table) => ([
  index("idx_feedback_memory").on(table.memory_id),
  index("idx_feedback_session").on(table.session_id),
]));

export const memoryInjections = sqliteTable("memory_injections", {
  id: text("id").primaryKey(),
  memory_id: text("memory_id")
    .notNull()
    .references(() => memories.id, { onDelete: "cascade" }),
  session_id: text("session_id").notNull(),
  repo: text("repo"),
  injected_at: text("injected_at").notNull(),
  outcome: text("outcome", {
    enum: ["followed", "overridden", "ignored", "contradicted"],
  }),
  outcome_at: text("outcome_at"),
}, (table) => ([
  index("idx_memory_injections_memory").on(table.memory_id),
  index("idx_memory_injections_session").on(table.session_id),
  uniqueIndex("uq_memory_injections_memory_session").on(table.memory_id, table.session_id),
]));

// Session/query activity log
export const activityEvents = sqliteTable("activity_events", {
  id: text("id").primaryKey(),
  session_id: text("session_id"),
  repo: text("repo"),
  path: text("path"),
  // source is a free-form string tagged as "<transport>[:<client>]"
  // (e.g. "mcp", "mcp:claude-code", "hook:codex", "cli", "daemon").
  // The runtime regex in src/types.ts validates the shape.
  source: text("source").notNull(),
  event_type: text("event_type", {
    enum: [
      "compile",
      "query",
      "scan",
      "correction",
      "review",
      "feedback",
      "signal",
      "session_start",
      "session_event",
      "session_end",
      "tool_call",
    ],
  }).notNull(),
  memory_ids: text("memory_ids", { mode: "json" }).notNull().default("[]"),
  request: text("request", { mode: "json" }).notNull().default("{}"),
  result: text("result", { mode: "json" }).notNull().default("{}"),
  created_at: text("created_at").notNull(),
}, (table) => ([
  index("idx_activity_session").on(table.session_id),
  index("idx_activity_repo").on(table.repo),
  index("idx_activity_event_type").on(table.event_type),
  index("idx_activity_created").on(table.created_at),
]));

export const hookCalls = sqliteTable("hook_calls", {
  id: text("id").primaryKey(),
  event: text("event", {
    enum: ["session_started", "prompt_submitted", "tool_invoked", "session_ended"],
  }).notNull(),
  agent: text("agent").notNull(),
  duration_ms: integer("duration_ms").notNull(),
  ok: integer("ok", { mode: "boolean" }).notNull(),
  created_at: text("created_at").notNull(),
}, (table) => ([
  index("idx_hook_calls_event").on(table.event),
  index("idx_hook_calls_agent").on(table.agent),
  index("idx_hook_calls_created").on(table.created_at),
]));

// Phase 2: sync state tracking
export const syncState = sqliteTable("sync_state", {
  id: text("id").primaryKey(), // "local" singleton
  remote_url: text("remote_url"),
  team_id: text("team_id"),
  last_push_at: text("last_push_at"),
  last_pull_at: text("last_pull_at"),
  last_push_version: integer("last_push_version").notNull().default(0),
  last_pull_version: integer("last_pull_version").notNull().default(0),
});

// Phase 2: evaluation sessions
export const evalSessions = sqliteTable("eval_sessions", {
  id: text("id").primaryKey(),
  repo: text("repo").notNull(),
  started_at: text("started_at").notNull(),
  ended_at: text("ended_at"),
  memories_injected: integer("memories_injected").notNull().default(0),
  memories_followed: integer("memories_followed").notNull().default(0),
  memories_overridden: integer("memories_overridden").notNull().default(0),
  user_corrections: integer("user_corrections").notNull().default(0),
  test_passes: integer("test_passes").notNull().default(0),
  test_failures: integer("test_failures").notNull().default(0),
}, (table) => ([
  index("idx_eval_repo").on(table.repo),
]));

// Phase 3: policy rules
export const policyRules = sqliteTable("policy_rules", {
  id: text("id").primaryKey(),
  org_id: text("org_id").notNull(),
  rule_type: text("rule_type", {
    enum: [
      "min_confidence",
      "require_approval",
      "allowed_sources",
      "blocked_scopes",
      "auto_approve_pattern",
      "max_active_per_repo",
      "require_evidence_count",
    ],
  }).notNull(),
  config: text("config", { mode: "json" }).notNull().default("{}"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
}, (table) => ([
  index("idx_policy_org").on(table.org_id),
]));

// Phase 3: approval queue
export const approvalRequests = sqliteTable("approval_requests", {
  id: text("id").primaryKey(),
  memory_id: text("memory_id")
    .notNull()
    .references(() => memories.id),
  org_id: text("org_id").notNull(),
  requested_by: text("requested_by").notNull(),
  status: text("status", {
    enum: ["pending", "approved", "denied"],
  }).notNull().default("pending"),
  reviewed_by: text("reviewed_by"),
  reason: text("reason"),
  created_at: text("created_at").notNull(),
  resolved_at: text("resolved_at"),
}, (table) => ([
  index("idx_approval_org").on(table.org_id),
  index("idx_approval_status").on(table.status),
]));

// Phase 3: contradictions
export const contradictions = sqliteTable("contradictions", {
  id: text("id").primaryKey(),
  memory_a_id: text("memory_a_id")
    .notNull()
    .references(() => memories.id),
  memory_b_id: text("memory_b_id")
    .notNull()
    .references(() => memories.id),
  contradiction_type: text("contradiction_type", {
    enum: ["direct_negation", "conflicting_rules", "scope_overlap", "superseded"],
  }).notNull(),
  severity: text("severity", { enum: ["low", "medium", "high"] }).notNull(),
  description: text("description").notNull(),
  resolved: integer("resolved", { mode: "boolean" }).notNull().default(false),
  resolution: text("resolution"),
  detected_at: text("detected_at").notNull(),
  resolved_at: text("resolved_at"),
}, (table) => ([
  index("idx_contradictions_resolved").on(table.resolved),
]));

// Phase 3: audit trail
export const auditTrail = sqliteTable("audit_trail", {
  id: text("id").primaryKey(),
  memory_id: text("memory_id").notNull(),
  action: text("action", {
    enum: [
      "created", "promoted", "demoted", "rejected", "confirmed",
      "reactivated", "edited", "pruned", "policy_applied",
      "approval_requested", "approval_resolved",
      "contradiction_detected", "contradiction_resolved", "rolled_back",
    ],
  }).notNull(),
  actor: text("actor").notNull(),
  before_snapshot: text("before_snapshot"),
  after_snapshot: text("after_snapshot"),
  reason: text("reason"),
  timestamp: text("timestamp").notNull(),
}, (table) => ([
  index("idx_audit_memory").on(table.memory_id),
  index("idx_audit_timestamp").on(table.timestamp),
]));

// Tier-2 delegated maintenance tasks
export const memoryMaintenanceTasks = sqliteTable("memory_maintenance_tasks", {
  id: text("id").primaryKey(),
  kind: text("kind", {
    enum: [
      "summarize_history",
      "merge_duplicates",
      "refine_candidate",
      "summarize_session",
      "synthesize_repo",
    ],
  }).notNull(),
  status: text("status", {
    enum: ["pending", "claimed", "submitted", "completed", "abandoned"],
  }).notNull(),
  priority: integer("priority").notNull().default(0),
  repo: text("repo"),
  target_key: text("target_key").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  result: text("result", { mode: "json" }),
  failure_reason: text("failure_reason"),
  claimed_by: text("claimed_by"),
  claimed_at: text("claimed_at"),
  claim_expires_at: text("claim_expires_at"),
  submitted_at: text("submitted_at"),
  completed_at: text("completed_at"),
  created_at: text("created_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
  max_attempts: integer("max_attempts").notNull().default(3),
}, (table) => ([
  index("idx_mmt_status_priority").on(table.status, table.priority, table.created_at),
  index("idx_mmt_repo_status").on(table.repo, table.status),
  index("idx_mmt_claim_expires").on(table.claim_expires_at),
  index("idx_mmt_kind_target").on(table.kind, table.target_key),
]));

// Phase 2: implicit feedback signals
export const implicitSignals = sqliteTable("implicit_signals", {
  id: text("id").primaryKey(),
  memory_id: text("memory_id")
    .notNull()
    .references(() => memories.id),
  session_id: text("session_id").notNull(),
  signal_type: text("signal_type", {
    enum: [
      "test_pass",
      "test_fail",
      "file_unchanged",
      "file_rewritten",
      "task_accepted",
      "task_rejected",
    ],
  }).notNull(),
  timestamp: text("timestamp").notNull(),
  context: text("context"),
}, (table) => ([
  index("idx_implicit_memory").on(table.memory_id),
  index("idx_implicit_session").on(table.session_id),
]));

// LLM usage tracking for daemon-owned maintenance dispatcher
export const llmUsage = sqliteTable("llm_usage", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  task_kind: text("task_kind").notNull(),
  task_id: text("task_id"),
  repo: text("repo"),
  prompt_tokens: integer("prompt_tokens").notNull().default(0),
  completion_tokens: integer("completion_tokens").notNull().default(0),
  total_tokens: integer("total_tokens").notNull().default(0),
  cost_usd: real("cost_usd"),
  duration_ms: integer("duration_ms").notNull().default(0),
  ok: integer("ok", { mode: "boolean" }).notNull().default(true),
  error: text("error"),
  created_at: text("created_at").notNull(),
}, (table) => ([
  index("idx_llm_usage_created").on(table.created_at),
  index("idx_llm_usage_provider_model").on(table.provider, table.model),
  index("idx_llm_usage_task_kind").on(table.task_kind),
  index("idx_llm_usage_repo").on(table.repo),
]));

// Phase-1 deterministic cleanup log (revertable, no LLM required)
export const maintenanceCleanupLog = sqliteTable("maintenance_cleanup_log", {
  id: text("id").primaryKey(),
  run_id: text("run_id").notNull(),
  action: text("action", {
    enum: [
      "dedupe_exact_merge",
      "reject_fragment_candidate",
      "promote_repeat_correction",
    ],
  }).notNull(),
  memory_id: text("memory_id").notNull(),
  related_memory_id: text("related_memory_id"),
  before_snapshot: text("before_snapshot", { mode: "json" }),
  after_snapshot: text("after_snapshot", { mode: "json" }),
  details: text("details", { mode: "json" }).notNull().default("{}"),
  reverted: integer("reverted", { mode: "boolean" }).notNull().default(false),
  reverted_at: text("reverted_at"),
  created_at: text("created_at").notNull(),
}, (table) => ([
  index("idx_cleanup_log_run").on(table.run_id),
  index("idx_cleanup_log_memory").on(table.memory_id),
  index("idx_cleanup_log_action").on(table.action),
  index("idx_cleanup_log_created").on(table.created_at),
]));
