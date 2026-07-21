CREATE TABLE `memory_value_events` (
	`id` text PRIMARY KEY NOT NULL,
	`memory_id` text,
	`injection_id` text,
	`feedback_id` text,
	`session_id` text NOT NULL,
	`repo` text,
	`event_type` text NOT NULL,
	`source` text NOT NULL,
	`injected_tokens_estimate` integer DEFAULT 0 NOT NULL,
	`saved_tokens_estimate` integer DEFAULT 0 NOT NULL,
	`evidence` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`injection_id`) REFERENCES `memory_injections`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`feedback_id`) REFERENCES `feedback_events`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_memory_value_memory` ON `memory_value_events` (`memory_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_value_session` ON `memory_value_events` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_value_repo` ON `memory_value_events` (`repo`);--> statement-breakpoint
CREATE INDEX `idx_memory_value_event` ON `memory_value_events` (`event_type`);--> statement-breakpoint
CREATE INDEX `idx_memory_value_created` ON `memory_value_events` (`created_at`);
