CREATE TABLE `hook_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`agent` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`ok` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_hook_calls_event` ON `hook_calls` (`event`);--> statement-breakpoint
CREATE INDEX `idx_hook_calls_agent` ON `hook_calls` (`agent`);--> statement-breakpoint
CREATE INDEX `idx_hook_calls_created` ON `hook_calls` (`created_at`);
