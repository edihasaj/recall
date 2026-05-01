ALTER TABLE `hook_calls` ADD `dedupe_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_hook_calls_dedupe_key` ON `hook_calls` (`dedupe_key`);