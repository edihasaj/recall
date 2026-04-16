ALTER TABLE `memories` ADD `capture_context` text;
--> statement-breakpoint
CREATE TABLE `memory_injections` (
	`id` text PRIMARY KEY NOT NULL,
	`memory_id` text NOT NULL,
	`session_id` text NOT NULL,
	`repo` text,
	`injected_at` text NOT NULL,
	`outcome` text,
	`outcome_at` text,
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_memory_injections_memory` ON `memory_injections` (`memory_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_injections_session` ON `memory_injections` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_memory_injections_memory_session` ON `memory_injections` (`memory_id`,`session_id`);
