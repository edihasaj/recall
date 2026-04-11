CREATE TABLE `activity_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`repo` text,
	`path` text,
	`source` text NOT NULL,
	`event_type` text NOT NULL,
	`memory_ids` text DEFAULT '[]' NOT NULL,
	`request` text DEFAULT '{}' NOT NULL,
	`result` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_activity_session` ON `activity_events` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_activity_repo` ON `activity_events` (`repo`);--> statement-breakpoint
CREATE INDEX `idx_activity_event_type` ON `activity_events` (`event_type`);--> statement-breakpoint
CREATE INDEX `idx_activity_created` ON `activity_events` (`created_at`);