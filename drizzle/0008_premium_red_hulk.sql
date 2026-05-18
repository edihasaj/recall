CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`repo` text,
	`description` text,
	`first_seen_memory_id` text,
	`mention_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_entities_normalized` ON `entities` (`normalized_name`);--> statement-breakpoint
CREATE INDEX `idx_entities_kind` ON `entities` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_entities_repo` ON `entities` (`repo`);--> statement-breakpoint
CREATE TABLE `entity_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`source_entity_id` text NOT NULL,
	`target_entity_id` text NOT NULL,
	`relation_type` text NOT NULL,
	`source_memory_id` text,
	`confidence` real DEFAULT 0.6 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`source_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_entity_relations_source` ON `entity_relations` (`source_entity_id`);--> statement-breakpoint
CREATE INDEX `idx_entity_relations_target` ON `entity_relations` (`target_entity_id`);--> statement-breakpoint
CREATE INDEX `idx_entity_relations_type` ON `entity_relations` (`relation_type`);--> statement-breakpoint
CREATE TABLE `memory_entities` (
	`id` text PRIMARY KEY NOT NULL,
	`memory_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`source` text DEFAULT 'heuristic' NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_memory_entities_memory` ON `memory_entities` (`memory_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_entities_entity` ON `memory_entities` (`entity_id`);