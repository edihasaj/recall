CREATE TABLE `quality_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`taken_at` text NOT NULL,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`injections_total` integer NOT NULL,
	`injections_resolved` integer NOT NULL,
	`injections_followed` integer NOT NULL,
	`injections_overridden` integer NOT NULL,
	`injections_contradicted` integer NOT NULL,
	`injections_ignored` integer NOT NULL,
	`followed_rate_resolved` real,
	`active_rule_count` integer NOT NULL,
	`active_command_count` integer NOT NULL,
	`candidate_correction_count` integer NOT NULL,
	`notes` text
);
--> statement-breakpoint
CREATE INDEX `idx_quality_snapshots_taken` ON `quality_snapshots` (`taken_at`);