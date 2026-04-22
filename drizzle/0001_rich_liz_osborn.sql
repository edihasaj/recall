CREATE TABLE `llm_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`task_kind` text NOT NULL,
	`task_id` text,
	`repo` text,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`ok` integer DEFAULT true NOT NULL,
	`error` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_llm_usage_created` ON `llm_usage` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_llm_usage_provider_model` ON `llm_usage` (`provider`,`model`);--> statement-breakpoint
CREATE INDEX `idx_llm_usage_task_kind` ON `llm_usage` (`task_kind`);--> statement-breakpoint
CREATE INDEX `idx_llm_usage_repo` ON `llm_usage` (`repo`);