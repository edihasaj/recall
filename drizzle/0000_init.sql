CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`memory_id` text NOT NULL,
	`org_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reviewed_by` text,
	`reason` text,
	`created_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_approval_org` ON `approval_requests` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_approval_status` ON `approval_requests` (`status`);--> statement-breakpoint
CREATE TABLE `audit_trail` (
	`id` text PRIMARY KEY NOT NULL,
	`memory_id` text NOT NULL,
	`action` text NOT NULL,
	`actor` text NOT NULL,
	`before_snapshot` text,
	`after_snapshot` text,
	`reason` text,
	`timestamp` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_memory` ON `audit_trail` (`memory_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_timestamp` ON `audit_trail` (`timestamp`);--> statement-breakpoint
CREATE TABLE `contradictions` (
	`id` text PRIMARY KEY NOT NULL,
	`memory_a_id` text NOT NULL,
	`memory_b_id` text NOT NULL,
	`contradiction_type` text NOT NULL,
	`severity` text NOT NULL,
	`description` text NOT NULL,
	`resolved` integer DEFAULT false NOT NULL,
	`resolution` text,
	`detected_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`memory_a_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`memory_b_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_contradictions_resolved` ON `contradictions` (`resolved`);--> statement-breakpoint
CREATE TABLE `eval_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`memories_injected` integer DEFAULT 0 NOT NULL,
	`memories_followed` integer DEFAULT 0 NOT NULL,
	`memories_overridden` integer DEFAULT 0 NOT NULL,
	`user_corrections` integer DEFAULT 0 NOT NULL,
	`test_passes` integer DEFAULT 0 NOT NULL,
	`test_failures` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_eval_repo` ON `eval_sessions` (`repo`);--> statement-breakpoint
CREATE TABLE `feedback_events` (
	`id` text PRIMARY KEY NOT NULL,
	`memory_id` text NOT NULL,
	`session_id` text NOT NULL,
	`injected` integer NOT NULL,
	`outcome` text NOT NULL,
	`timestamp` text NOT NULL,
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_feedback_memory` ON `feedback_events` (`memory_id`);--> statement-breakpoint
CREATE INDEX `idx_feedback_session` ON `feedback_events` (`session_id`);--> statement-breakpoint
CREATE TABLE `implicit_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`memory_id` text NOT NULL,
	`session_id` text NOT NULL,
	`signal_type` text NOT NULL,
	`timestamp` text NOT NULL,
	`context` text,
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_implicit_memory` ON `implicit_signals` (`memory_id`);--> statement-breakpoint
CREATE INDEX `idx_implicit_session` ON `implicit_signals` (`session_id`);--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`text` text NOT NULL,
	`scope` text NOT NULL,
	`path_scope` text,
	`repo` text,
	`status` text NOT NULL,
	`confidence` real DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`evidence` text DEFAULT '[]' NOT NULL,
	`supersedes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_validated_at` text,
	`last_injected_at` text,
	`injection_count` integer DEFAULT 0 NOT NULL,
	`override_count` integer DEFAULT 0 NOT NULL,
	`team_id` text,
	`sync_version` integer DEFAULT 0 NOT NULL,
	`embedding` blob
);
--> statement-breakpoint
CREATE INDEX `idx_memories_repo` ON `memories` (`repo`);--> statement-breakpoint
CREATE INDEX `idx_memories_status` ON `memories` (`status`);--> statement-breakpoint
CREATE INDEX `idx_memories_repo_status` ON `memories` (`repo`,`status`);--> statement-breakpoint
CREATE INDEX `idx_memories_team` ON `memories` (`team_id`);--> statement-breakpoint
CREATE TABLE `policy_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`rule_type` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_policy_org` ON `policy_rules` (`org_id`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`id` text PRIMARY KEY NOT NULL,
	`remote_url` text,
	`team_id` text,
	`last_push_at` text,
	`last_pull_at` text,
	`last_push_version` integer DEFAULT 0 NOT NULL,
	`last_pull_version` integer DEFAULT 0 NOT NULL
);
