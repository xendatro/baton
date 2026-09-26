-- The audit log's filter values per team, kept by recordActivity (server/services/activity.ts),
-- so GET /api/teams/:teamId/audit-log/facets never scans the append-only log (PERF-03).
CREATE TABLE `activity_facet` (
	`team_id` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`key_name` text,
	`actor_id` text,
	`last_at` integer,
	PRIMARY KEY(`team_id`, `kind`, `value`)
);
--> statement-breakpoint
-- Backfill from the rows written so far.
INSERT OR IGNORE INTO `activity_facet` (`team_id`, `kind`, `value`)
SELECT DISTINCT `team_id`, 'actor', `actor_id` FROM `activity`
WHERE `team_id` IS NOT NULL AND `actor_id` IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `activity_facet` (`team_id`, `kind`, `value`)
SELECT DISTINCT `team_id`, 'source', `source` FROM `activity` WHERE `team_id` IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `activity_facet` (`team_id`, `kind`, `value`)
SELECT DISTINCT `team_id`, 'entity_type', `entity_type` FROM `activity` WHERE `team_id` IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `activity_facet` (`team_id`, `kind`, `value`)
SELECT DISTINCT `team_id`, 'action', `action` FROM `activity` WHERE `team_id` IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `activity_facet` (`team_id`, `kind`, `value`)
SELECT DISTINCT `team_id`, 'project', `project_id` FROM `activity`
WHERE `team_id` IS NOT NULL AND `project_id` IS NOT NULL;
--> statement-breakpoint
-- SQLite takes the bare columns of a max() aggregate from the row holding the maximum, so each
-- key gets the name snapshot and owner of its latest row.
INSERT OR IGNORE INTO `activity_facet` (`team_id`, `kind`, `value`, `key_name`, `actor_id`, `last_at`)
SELECT `team_id`, 'key', `via_key_id`, `via_key_name`, `actor_id`, max(`created_at`) FROM `activity`
WHERE `team_id` IS NOT NULL AND `via_key_id` IS NOT NULL
GROUP BY `team_id`, `via_key_id`;
