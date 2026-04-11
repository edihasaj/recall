import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

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
