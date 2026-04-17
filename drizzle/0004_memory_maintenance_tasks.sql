CREATE TABLE `memory_maintenance_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`repo` text,
	`target_key` text NOT NULL,
	`payload` text NOT NULL,
	`result` text,
	`failure_reason` text,
	`claimed_by` text,
	`claimed_at` text,
	`claim_expires_at` text,
	`submitted_at` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_mmt_status_priority` ON `memory_maintenance_tasks` (`status`,`priority`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_mmt_repo_status` ON `memory_maintenance_tasks` (`repo`,`status`);--> statement-breakpoint
CREATE INDEX `idx_mmt_claim_expires` ON `memory_maintenance_tasks` (`claim_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_mmt_kind_target` ON `memory_maintenance_tasks` (`kind`,`target_key`);
