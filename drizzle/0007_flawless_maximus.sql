CREATE TABLE `history_injections` (
	`id` text PRIMARY KEY NOT NULL,
	`snippet_id` text NOT NULL,
	`session_id` text NOT NULL,
	`repo` text,
	`injected_at` text NOT NULL,
	FOREIGN KEY (`snippet_id`) REFERENCES `history_snippets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_history_injections_snippet` ON `history_injections` (`snippet_id`);--> statement-breakpoint
CREATE INDEX `idx_history_injections_session` ON `history_injections` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_history_injections_repo` ON `history_injections` (`repo`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_history_injections_snippet_session` ON `history_injections` (`snippet_id`,`session_id`);--> statement-breakpoint
ALTER TABLE `quality_snapshots` ADD `history_injections_total` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `quality_snapshots` ADD `history_snippets_injected` integer DEFAULT 0 NOT NULL;