import { z } from "zod";

// --- Enums ---

export const MemoryStatus = z.enum([
  "transient",
  "candidate",
  "active",
  "rejected",
]);
export type MemoryStatus = z.infer<typeof MemoryStatus>;

export const MemoryType = z.enum([
  "rule",
  "command",
  "gotcha",
  "decision",
  "review_pattern",
]);
export type MemoryType = z.infer<typeof MemoryType>;

export const MemoryScope = z.enum(["session", "path", "repo", "team"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

export const MemorySource = z.enum([
  "user_correction",
  "user_reported_review",
  "repo_scan",
  "config_parse",
]);
export type MemorySource = z.infer<typeof MemorySource>;

export const FeedbackOutcome = z.enum([
  "followed",
  "overridden",
  "ignored",
  "contradicted",
]);
export type FeedbackOutcome = z.infer<typeof FeedbackOutcome>;

// --- Evidence ---

export const EvidenceEntry = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session_correction"),
    session: z.string(),
    timestamp: z.string(),
    context: z.string().optional(),
  }),
  z.object({
    type: z.literal("review_feedback"),
    reported_by_user: z.boolean(),
    reviewer: z.string().optional(),
    timestamp: z.string(),
    context: z.string().optional(),
  }),
  z.object({
    type: z.literal("repo_scan"),
    file: z.string(),
    timestamp: z.string(),
  }),
  z.object({
    type: z.literal("repeated_correction"),
    count: z.number(),
    sessions: z.array(z.string()),
    timestamp: z.string(),
  }),
]);
export type EvidenceEntry = z.infer<typeof EvidenceEntry>;

export const CaptureContextToolCall = z.object({
  name: z.string(),
  path: z.string().optional(),
  exit_code: z.number().optional(),
});
export type CaptureContextToolCall = z.infer<typeof CaptureContextToolCall>;

export const CaptureContext = z.object({
  prev_assistant_text: z.string().optional(),
  recent_tool_calls: z.array(CaptureContextToolCall).max(5).optional(),
  repo: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  agent: z.string().optional(),
});
export type CaptureContext = z.infer<typeof CaptureContext>;

// --- Memory Item ---

export const MemoryItem = z.object({
  id: z.string().uuid(),
  type: MemoryType,
  text: z.string(),
  scope: MemoryScope,
  path_scope: z.string().nullable(),
  repo: z.string().nullable(),
  status: MemoryStatus,
  confidence: z.number().min(0).max(1),
  source: MemorySource,
  evidence: z.array(EvidenceEntry),
  capture_context: CaptureContext.nullable(),
  supersedes: z.string().uuid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  last_validated_at: z.string().nullable(),
  last_injected_at: z.string().nullable(),
  injection_count: z.number().int().nonnegative(),
  override_count: z.number().int().nonnegative(),
});
export type MemoryItem = z.infer<typeof MemoryItem>;

// --- Feedback Event ---

export const FeedbackEvent = z.object({
  id: z.string().uuid(),
  memory_id: z.string().uuid(),
  session_id: z.string(),
  injected: z.boolean(),
  outcome: FeedbackOutcome,
  timestamp: z.string(),
});
export type FeedbackEvent = z.infer<typeof FeedbackEvent>;

export const MemoryInjection = z.object({
  id: z.string().uuid(),
  memory_id: z.string().uuid(),
  session_id: z.string(),
  repo: z.string().nullable(),
  injected_at: z.string(),
  outcome: FeedbackOutcome.nullable(),
  outcome_at: z.string().nullable(),
});
export type MemoryInjection = z.infer<typeof MemoryInjection>;

// --- Activity events ---

export const ActivitySource = z.enum(["cli", "daemon", "mcp", "system"]);
export type ActivitySource = z.infer<typeof ActivitySource>;

export const ActivityEventType = z.enum([
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
]);
export type ActivityEventType = z.infer<typeof ActivityEventType>;

export const ActivityEvent = z.object({
  id: z.string().uuid(),
  session_id: z.string().nullable(),
  repo: z.string().nullable(),
  path: z.string().nullable(),
  source: ActivitySource,
  event_type: ActivityEventType,
  memory_ids: z.array(z.string().uuid()),
  request: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});
export type ActivityEvent = z.infer<typeof ActivityEvent>;

export const ActivityEventQuery = z.object({
  repo: z.string().optional(),
  session_id: z.string().optional(),
  source: ActivitySource.optional(),
  event_type: ActivityEventType.optional(),
  since: z.string().optional(),
  limit: z.number().int().positive().optional(),
});
export type ActivityEventQuery = z.infer<typeof ActivityEventQuery>;

export const HookCallEvent = z.enum([
  "session_started",
  "prompt_submitted",
  "tool_invoked",
  "session_ended",
]);
export type HookCallEvent = z.infer<typeof HookCallEvent>;

export const HookCall = z.object({
  id: z.string().uuid(),
  event: HookCallEvent,
  agent: z.string(),
  duration_ms: z.number().int().nonnegative(),
  ok: z.boolean(),
  created_at: z.string(),
});
export type HookCall = z.infer<typeof HookCall>;

export const HookCallStatsQuery = z.object({
  agent: z.string().optional(),
  event: HookCallEvent.optional(),
  limit: z.number().int().positive().optional(),
});
export type HookCallStatsQuery = z.infer<typeof HookCallStatsQuery>;

export const HookCallStatsRow = z.object({
  event: HookCallEvent,
  agent: z.string(),
  total_calls: z.number().int().nonnegative(),
  ok_calls: z.number().int().nonnegative(),
  error_calls: z.number().int().nonnegative(),
  avg_duration_ms: z.number().nonnegative(),
  max_duration_ms: z.number().int().nonnegative(),
  last_called_at: z.string(),
});
export type HookCallStatsRow = z.infer<typeof HookCallStatsRow>;

// --- Confidence thresholds ---

export const CONFIDENCE = {
  /** Below this → transient, never stored durably */
  TRANSIENT_MAX: 0.3,
  /** Below this → candidate, stored but not injected */
  CANDIDATE_MAX: 0.6,
  /** At or above this → active, injected when scope matches */
  ACTIVE_MIN: 0.6,
} as const;

// --- Promotion weights ---

export const PROMOTION = {
  /** User explicitly confirms */
  EXPLICIT_CONFIRM: 0.8,
  /** Same correction repeats */
  REPEAT_CORRECTION: 0.2,
  /** User-reported review feedback */
  REVIEW_FEEDBACK: 0.3,
  /** Passive gain per use without override */
  PASSIVE_GAIN: 0.05,
} as const;

// --- Compiler config ---

export const CompilerConfig = z.object({
  confidence_threshold: z.number().default(0.6),
  max_lines: z.number().default(15),
  max_commands: z.number().default(3),
  max_gotchas: z.number().default(3),
  token_budget: z.number().default(2000),
  include_candidates: z.boolean().default(false),
});
export type CompilerConfig = z.infer<typeof CompilerConfig>;

// --- Query ---

export const MemoryQuery = z.object({
  repo: z.string().optional(),
  path: z.string().optional(),
  scope: MemoryScope.optional(),
  type: MemoryType.optional(),
  status: MemoryStatus.optional(),
  min_confidence: z.number().optional(),
  semantic_query: z.string().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});
export type MemoryQuery = z.infer<typeof MemoryQuery>;

// --- Sync (Phase 2) ---

export const SyncConfig = z.object({
  remote_url: z.string().url(),
  api_key: z.string(),
  team_id: z.string().optional(),
  auto_sync: z.boolean().default(false),
  sync_interval_seconds: z.number().default(300),
});
export type SyncConfig = z.infer<typeof SyncConfig>;

export const SyncDirection = z.enum(["push", "pull", "both"]);
export type SyncDirection = z.infer<typeof SyncDirection>;

export const SyncResult = z.object({
  pushed: z.number(),
  pulled: z.number(),
  conflicts: z.number(),
  errors: z.array(z.string()),
});
export type SyncResult = z.infer<typeof SyncResult>;

// --- Team (Phase 2) ---

export const TeamMember = z.object({
  id: z.string().uuid(),
  team_id: z.string().uuid(),
  user_id: z.string(),
  role: z.enum(["owner", "admin", "member"]),
  joined_at: z.string(),
});
export type TeamMember = z.infer<typeof TeamMember>;

// --- Embeddings (Phase 2) ---

export const EmbeddingConfig = z.object({
  provider: z.enum(["nomic", "multilingual-e5", "bge-small-en-v1.5"]).default("nomic"),
  model: z.string().default("nomic-ai/nomic-embed-text-v1.5"),
  dimensions: z.number().default(512),
  version: z.string().default("v1"),
  similarity_threshold: z.number().default(0.8),
});
export type EmbeddingConfig = z.infer<typeof EmbeddingConfig>;

export const HistorySnippetKind = z.enum([
  "session_summary",
  "correction_summary",
  "review_summary",
  "compile_summary",
]);
export type HistorySnippetKind = z.infer<typeof HistorySnippetKind>;

export const HistorySnippet = z.object({
  id: z.string().uuid(),
  repo: z.string().nullable(),
  session_id: z.string().nullable(),
  kind: HistorySnippetKind,
  text: z.string(),
  source_activity_ids: z.array(z.string().uuid()),
  created_at: z.string(),
  updated_at: z.string(),
});
export type HistorySnippet = z.infer<typeof HistorySnippet>;

// --- Evaluation (Phase 2) ---

export const EvalSession = z.object({
  id: z.string().uuid(),
  repo: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  memories_injected: z.number(),
  memories_followed: z.number(),
  memories_overridden: z.number(),
  user_corrections: z.number(),
  test_passes: z.number(),
  test_failures: z.number(),
});
export type EvalSession = z.infer<typeof EvalSession>;

export const EvalMetrics = z.object({
  total_sessions: z.number(),
  injection_rate: z.number(),
  follow_rate: z.number(),
  override_rate: z.number(),
  correction_frequency: z.number(),
  avg_confidence_at_injection: z.number(),
  memory_effectiveness: z.number(),
});
export type EvalMetrics = z.infer<typeof EvalMetrics>;

export const RetrievalEvalCase = z.object({
  name: z.string(),
  repo: z.string(),
  path: z.string().optional(),
  query_text: z.string().default(""),
  include_candidates: z.boolean().default(false),
  confidence_threshold: z.number().optional(),
  max_lines: z.number().optional(),
  max_commands: z.number().optional(),
  max_gotchas: z.number().optional(),
  token_budget: z.number().optional(),
  expected_all_texts: z.array(z.string()).default([]),
  expected_any_texts: z.array(z.string()).default([]),
  forbidden_texts: z.array(z.string()).default([]),
  min_included: z.number().int().nonnegative().optional(),
  max_included: z.number().int().nonnegative().optional(),
});
export type RetrievalEvalCase = z.infer<typeof RetrievalEvalCase>;

export const RetrievalEvalFile = z.object({
  cases: z.array(RetrievalEvalCase),
});
export type RetrievalEvalFile = z.infer<typeof RetrievalEvalFile>;

// --- Implicit feedback (Phase 2) ---

export const ImplicitSignal = z.object({
  id: z.string().uuid(),
  memory_id: z.string().uuid(),
  session_id: z.string(),
  signal_type: z.enum([
    "test_pass",
    "test_fail",
    "file_unchanged",
    "file_rewritten",
    "task_accepted",
    "task_rejected",
  ]),
  timestamp: z.string(),
  context: z.string().optional(),
});
export type ImplicitSignal = z.infer<typeof ImplicitSignal>;

// --- Recall config (Phase 2) ---

export const RecallConfig = z.object({
  sync: SyncConfig.optional(),
  embeddings: EmbeddingConfig.optional(),
});
export type RecallConfig = z.infer<typeof RecallConfig>;

// --- Policy (Phase 3) ---

export const PolicyRule = z.object({
  id: z.string().uuid(),
  org_id: z.string(),
  rule_type: z.enum([
    "min_confidence",
    "require_approval",
    "allowed_sources",
    "blocked_scopes",
    "auto_approve_pattern",
    "max_active_per_repo",
    "require_evidence_count",
  ]),
  config: z.record(z.unknown()),
  enabled: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type PolicyRule = z.infer<typeof PolicyRule>;

export const ApprovalStatus = z.enum(["pending", "approved", "denied"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const ApprovalRequest = z.object({
  id: z.string().uuid(),
  memory_id: z.string().uuid(),
  org_id: z.string(),
  requested_by: z.string(),
  status: ApprovalStatus,
  reviewed_by: z.string().nullable(),
  reason: z.string().nullable(),
  created_at: z.string(),
  resolved_at: z.string().nullable(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

// --- Health scoring (Phase 3) ---

export const HealthScore = z.object({
  memory_id: z.string().uuid(),
  score: z.number().min(0).max(1),
  confidence_component: z.number(),
  freshness_component: z.number(),
  follow_rate_component: z.number(),
  signal_ratio_component: z.number(),
  computed_at: z.string(),
});
export type HealthScore = z.infer<typeof HealthScore>;

// --- Contradiction (Phase 3) ---

export const Contradiction = z.object({
  id: z.string().uuid(),
  memory_a_id: z.string().uuid(),
  memory_b_id: z.string().uuid(),
  contradiction_type: z.enum([
    "direct_negation",
    "conflicting_rules",
    "scope_overlap",
    "superseded",
  ]),
  severity: z.enum(["low", "medium", "high"]),
  description: z.string(),
  resolved: z.boolean(),
  resolution: z.string().nullable(),
  detected_at: z.string(),
  resolved_at: z.string().nullable(),
});
export type Contradiction = z.infer<typeof Contradiction>;

// --- Pruning config (Phase 3) ---

export const PruneConfig = z.object({
  repo: z.string().optional(),
  stale_days: z.number().default(90),
  rejected_retention_days: z.number().default(30),
  transient_retention_days: z.number().default(7),
  min_health_score: z.number().default(0.2),
  dry_run: z.boolean().default(false),
});
export type PruneConfig = z.infer<typeof PruneConfig>;

// --- Audit trail (Phase 3) ---

export const AuditAction = z.enum([
  "created",
  "promoted",
  "demoted",
  "rejected",
  "confirmed",
  "reactivated",
  "edited",
  "pruned",
  "policy_applied",
  "approval_requested",
  "approval_resolved",
  "contradiction_detected",
  "contradiction_resolved",
  "rolled_back",
]);
export type AuditAction = z.infer<typeof AuditAction>;

export const AuditEntry = z.object({
  id: z.string().uuid(),
  memory_id: z.string().uuid(),
  action: AuditAction,
  actor: z.string(),
  before_snapshot: z.string().nullable(),
  after_snapshot: z.string().nullable(),
  reason: z.string().nullable(),
  timestamp: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;
