import { sqliteTable, text, integer, real, blob } from "drizzle-orm/sqlite-core";

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
  embedding: blob("embedding", { mode: "buffer" }),
});

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
});

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
});

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
});
