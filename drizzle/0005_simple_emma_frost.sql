ALTER TABLE `activity_events` ADD `dedupe_key` text;--> statement-breakpoint
UPDATE `activity_events`
SET `dedupe_key` =
  'activity' || char(31) ||
  coalesce(`session_id`, '') || char(31) ||
  coalesce(`repo`, '') || char(31) ||
  coalesce(`path`, '') || char(31) ||
  `source` || char(31) ||
  `event_type` || char(31) ||
  `request` || char(31) ||
  `result`
WHERE `session_id` IS NOT NULL
  AND `id` IN (
    SELECT `id` FROM (
      SELECT
        `id`,
        row_number() OVER (
          PARTITION BY
            coalesce(`session_id`, ''),
            coalesce(`repo`, ''),
            coalesce(`path`, ''),
            `source`,
            `event_type`,
            `request`,
            `result`
          ORDER BY `created_at`, `id`
        ) AS `rn`
      FROM `activity_events`
      WHERE `session_id` IS NOT NULL
    )
    WHERE `rn` = 1
  );--> statement-breakpoint
CREATE UNIQUE INDEX `uq_activity_events_dedupe_key` ON `activity_events` (`dedupe_key`);--> statement-breakpoint
ALTER TABLE `history_snippets` ADD `dedupe_key` text;--> statement-breakpoint
UPDATE `history_snippets`
SET `dedupe_key` =
  'history' || char(31) ||
  coalesce(`repo`, '') || char(31) ||
  coalesce(`session_id`, '') || char(31) ||
  `kind` || char(31) ||
  lower(trim(rtrim(`text`, ' .;:,!?`')))
WHERE `id` IN (
  SELECT `id` FROM (
    SELECT
      `id`,
      row_number() OVER (
        PARTITION BY
          coalesce(`repo`, ''),
          coalesce(`session_id`, ''),
          `kind`,
          lower(trim(rtrim(`text`, ' .;:,!?`')))
        ORDER BY `created_at`, `id`
      ) AS `rn`
    FROM `history_snippets`
  )
  WHERE `rn` = 1
);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_history_snippets_dedupe_key` ON `history_snippets` (`dedupe_key`);--> statement-breakpoint
ALTER TABLE `memories` ADD `dedupe_key` text;--> statement-breakpoint
UPDATE `memories`
SET `dedupe_key` =
  'memory' || char(31) ||
  `type` || char(31) ||
  `scope` || char(31) ||
  coalesce(`repo`, '') || char(31) ||
  coalesce(`path_scope`, '') || char(31) ||
  lower(trim(rtrim(`text`, ' .;:,!?`')))
WHERE `status` != 'rejected'
  AND `id` IN (
    SELECT `id` FROM (
      SELECT
        `id`,
        row_number() OVER (
          PARTITION BY
            `type`,
            `scope`,
            coalesce(`repo`, ''),
            coalesce(`path_scope`, ''),
            lower(trim(rtrim(`text`, ' .;:,!?`')))
          ORDER BY
            CASE `status`
              WHEN 'active' THEN 0
              WHEN 'candidate' THEN 1
              WHEN 'transient' THEN 2
              ELSE 3
            END,
            `confidence` DESC,
            `created_at`,
            `id`
        ) AS `rn`
      FROM `memories`
      WHERE `status` != 'rejected'
    )
    WHERE `rn` = 1
  );--> statement-breakpoint
CREATE UNIQUE INDEX `uq_memories_dedupe_key` ON `memories` (`dedupe_key`);
