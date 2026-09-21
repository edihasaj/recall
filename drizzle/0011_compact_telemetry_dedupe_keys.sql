DELETE FROM `activity_events` AS `legacy`
WHERE `legacy`.`dedupe_key` IS NOT NULL
  AND `legacy`.`dedupe_key` NOT LIKE ('activity' || char(31) || 'sha256:%')
  AND EXISTS (
    SELECT 1 FROM `activity_events` AS `compact`
    WHERE `compact`.`dedupe_key` = 'activity' || char(31) || 'sha256:' || recall_sha256(`legacy`.`dedupe_key`)
  );
--> statement-breakpoint
UPDATE `activity_events`
SET `dedupe_key` = 'activity' || char(31) || 'sha256:' || recall_sha256(`dedupe_key`)
WHERE `dedupe_key` IS NOT NULL
  AND `dedupe_key` NOT LIKE ('activity' || char(31) || 'sha256:%');
--> statement-breakpoint
DELETE FROM `hook_calls` AS `legacy`
WHERE `legacy`.`dedupe_key` IS NOT NULL
  AND `legacy`.`dedupe_key` NOT LIKE ('hook' || char(31) || 'sha256:%')
  AND EXISTS (
    SELECT 1 FROM `hook_calls` AS `compact`
    WHERE `compact`.`dedupe_key` = 'hook' || char(31) || 'sha256:' || recall_sha256(`legacy`.`dedupe_key`)
  );
--> statement-breakpoint
UPDATE `hook_calls`
SET `dedupe_key` = 'hook' || char(31) || 'sha256:' || recall_sha256(`dedupe_key`)
WHERE `dedupe_key` IS NOT NULL
  AND `dedupe_key` NOT LIKE ('hook' || char(31) || 'sha256:%');
