import { sqliteTable, text, integer, real, blob, index } from "drizzle-orm/sqlite-core";

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
  supersedes: text("supersedes"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
  last_validated_at: text("last_validated_at"),
  last_injected_at: text("last_injected_at"),
  injection_count: integer("injection_count").notNull().default(0),
  override_count: integer("override_count").notNull().default(0),
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
  dimensions: integer("dimensions").notNull(),
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
    enum: ["session_summary", "correction_summary", "review_summary", "compile_summary"],
  }).notNull(),
  text: text("text").notNull(),
  source_activity_ids: text("source_activity_ids", { mode: "json" }).notNull().default("[]"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
  archived_at: text("archived_at"),
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
  dimensions: integer("dimensions").notNull(),
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

// Session/query activity log
export const activityEvents = sqliteTable("activity_events", {
  id: text("id").primaryKey(),
  session_id: text("session_id"),
  repo: text("repo"),
  path: text("path"),
  source: text("source", {
    enum: ["cli", "daemon", "mcp", "system"],
  }).notNull(),
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
      "reactivated", "edited", "pruned", "archived", "policy_applied",
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
