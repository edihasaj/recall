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
});
export type MemoryQuery = z.infer<typeof MemoryQuery>;
