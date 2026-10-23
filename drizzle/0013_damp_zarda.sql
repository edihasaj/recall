CREATE TABLE `temporal_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`event_id` text NOT NULL,
	`subject` text NOT NULL,
	`predicate` text NOT NULL,
	`value` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`observed_at` text NOT NULL,
	`evidence` text NOT NULL,
	`source` text,
	`confidence` real DEFAULT 0.5 NOT NULL,
	`supersedes_id` text,
	`recorded_at` text NOT NULL,
	FOREIGN KEY (`supersedes_id`) REFERENCES `temporal_facts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_temporal_facts_repo_event` ON `temporal_facts` (`repo`,`event_id`);--> statement-breakpoint
CREATE INDEX `idx_temporal_facts_lookup` ON `temporal_facts` (`repo`,`subject`,`predicate`);--> statement-breakpoint
CREATE INDEX `idx_temporal_facts_observed` ON `temporal_facts` (`observed_at`);--> statement-breakpoint
CREATE INDEX `idx_temporal_facts_supersedes` ON `temporal_facts` (`supersedes_id`);