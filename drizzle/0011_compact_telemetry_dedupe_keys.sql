UPDATE `activity_events`
SET `dedupe_key` = 'activity' || char(31) || 'sha256:' || recall_sha256(`dedupe_key`)
WHERE `dedupe_key` IS NOT NULL
  AND `dedupe_key` NOT LIKE ('activity' || char(31) || 'sha256:%');
--> statement-breakpoint
UPDATE `hook_calls`
SET `dedupe_key` = 'hook' || char(31) || 'sha256:' || recall_sha256(`dedupe_key`)
WHERE `dedupe_key` IS NOT NULL
  AND `dedupe_key` NOT LIKE ('hook' || char(31) || 'sha256:%');
