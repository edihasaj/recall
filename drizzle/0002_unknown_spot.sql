CREATE TABLE `maintenance_cleanup_log` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`action` text NOT NULL,
	`memory_id` text NOT NULL,
	`related_memory_id` text,
	`before_snapshot` text,
	`after_snapshot` text,
	`details` text DEFAULT '{}' NOT NULL,
	`reverted` integer DEFAULT false NOT NULL,
	`reverted_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_cleanup_log_run` ON `maintenance_cleanup_log` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_cleanup_log_memory` ON `maintenance_cleanup_log` (`memory_id`);--> statement-breakpoint
CREATE INDEX `idx_cleanup_log_action` ON `maintenance_cleanup_log` (`action`);--> statement-breakpoint
CREATE INDEX `idx_cleanup_log_created` ON `maintenance_cleanup_log` (`created_at`);