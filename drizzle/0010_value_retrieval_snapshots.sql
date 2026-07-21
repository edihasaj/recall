ALTER TABLE `quality_snapshots` ADD `value_eval_cases` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `quality_snapshots` ADD `value_eval_hybrid_passed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `quality_snapshots` ADD `value_eval_recall_at_k` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `quality_snapshots` ADD `value_eval_mrr` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `quality_snapshots` ADD `value_eval_override_rate` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `quality_snapshots` ADD `value_eval_skipped_events` integer DEFAULT 0 NOT NULL;
