-- Stages (2026-09-27): statuses lose their hidden open/done category (the column stays, unused),
-- gain an icon and explicit stage rules, and assignments belong to a task and a stage.
ALTER TABLE `status` ADD `icon` text DEFAULT 'circle' NOT NULL;--> statement-breakpoint
ALTER TABLE `status` ADD `on_enter` text;--> statement-breakpoint
ALTER TABLE `status` ADD `blocks_dependents` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `status` ADD `claimable` integer DEFAULT true NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_task_assignee_role` (
	`task_id` text NOT NULL,
	`status_id` text NOT NULL,
	`role_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `status_id`, `role_id`),
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`status_id`) REFERENCES `status`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `role`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Existing assignments become the assignments of the task's current status.
INSERT INTO `__new_task_assignee_role`("task_id", "status_id", "role_id") SELECT a."task_id", t."status_id", a."role_id" FROM `task_assignee_role` a JOIN `task` t ON t."id" = a."task_id";--> statement-breakpoint
DROP TABLE `task_assignee_role`;--> statement-breakpoint
ALTER TABLE `__new_task_assignee_role` RENAME TO `task_assignee_role`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `task_assignee_role_role_idx` ON `task_assignee_role` (`role_id`);--> statement-breakpoint
CREATE INDEX `task_assignee_role_status_idx` ON `task_assignee_role` (`status_id`);--> statement-breakpoint
CREATE TABLE `__new_task_assignee_user` (
	`task_id` text NOT NULL,
	`status_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `status_id`, `user_id`),
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`status_id`) REFERENCES `status`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_task_assignee_user`("task_id", "status_id", "user_id") SELECT a."task_id", t."status_id", a."user_id" FROM `task_assignee_user` a JOIN `task` t ON t."id" = a."task_id";--> statement-breakpoint
DROP TABLE `task_assignee_user`;--> statement-breakpoint
ALTER TABLE `__new_task_assignee_user` RENAME TO `task_assignee_user`;--> statement-breakpoint
CREATE INDEX `task_assignee_user_user_idx` ON `task_assignee_user` (`user_id`);--> statement-breakpoint
CREATE INDEX `task_assignee_user_status_idx` ON `task_assignee_user` (`status_id`);--> statement-breakpoint
-- History: who held the task in each earlier stage, from the latest recorded visit of that stage.
INSERT OR IGNORE INTO `task_assignee_user` ("task_id", "status_id", "user_id")
SELECT e."task_id", e."status_id", j."value"
FROM `task_stage_entry` e
JOIN `task` t ON t."id" = e."task_id"
JOIN json_each(e."holder_user_ids") j
JOIN `user` u ON u."id" = j."value"
WHERE e."holder_user_ids" IS NOT NULL
  AND e."status_id" <> t."status_id"
  AND NOT EXISTS (
    SELECT 1 FROM `task_stage_entry` later
    WHERE later."task_id" = e."task_id"
      AND later."status_id" = e."status_id"
      AND later."holder_user_ids" IS NOT NULL
      AND (later."entered_at" > e."entered_at" OR (later."entered_at" = e."entered_at" AND later."id" > e."id"))
  );--> statement-breakpoint
-- Tasks in a former done status without a hand-off: that stage now assigns nobody, so their
-- assignees become history of the stage they were in before (the latest recorded one, else the
-- project's default or first open status); they no longer count as anyone's work.
CREATE TEMP TABLE `__stages_finished` AS
SELECT t."id" AS "task_id", t."status_id" AS "status_id", coalesce(
  (SELECT e."status_id" FROM `task_stage_entry` e
    WHERE e."task_id" = t."id" AND e."status_id" <> t."status_id" AND e."left_at" IS NOT NULL
    ORDER BY e."left_at" DESC, e."id" DESC LIMIT 1),
  (SELECT st."id" FROM `status` st
    WHERE st."project_id" = t."project_id" AND st."category" = 'open'
    ORDER BY st."is_default" DESC, st."position" ASC LIMIT 1)
) AS "previous_id"
FROM `task` t JOIN `status` cs ON cs."id" = t."status_id"
WHERE cs."category" = 'done' AND cs."handoff" IS NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `task_assignee_user` ("task_id", "status_id", "user_id")
SELECT a."task_id", f."previous_id", a."user_id"
FROM `__stages_finished` f
JOIN `task_assignee_user` a ON a."task_id" = f."task_id" AND a."status_id" = f."status_id"
WHERE f."previous_id" IS NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `task_assignee_role` ("task_id", "status_id", "role_id")
SELECT a."task_id", f."previous_id", a."role_id"
FROM `__stages_finished` f
JOIN `task_assignee_role` a ON a."task_id" = f."task_id" AND a."status_id" = f."status_id"
WHERE f."previous_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM `task_assignee_user` WHERE EXISTS (
  SELECT 1 FROM `__stages_finished` f
  WHERE f."task_id" = `task_assignee_user`."task_id" AND f."status_id" = `task_assignee_user`."status_id"
);--> statement-breakpoint
DELETE FROM `task_assignee_role` WHERE EXISTS (
  SELECT 1 FROM `__stages_finished` f
  WHERE f."task_id" = `task_assignee_role`."task_id" AND f."status_id" = `task_assignee_role`."status_id"
);--> statement-breakpoint
DROP TABLE `__stages_finished`;--> statement-breakpoint
-- What a done status did becomes its explicit rules: resolve fixed issues, release the claim and
-- tell the author on enter, assign nobody (unless it already had a hand-off), don't block
-- dependents, not claimable. Its icon is the check it always showed.
UPDATE `status` SET
  "icon" = 'check-circle',
  "on_enter" = '{"resolveIssues":true,"releaseClaim":true,"notifyAuthor":true}',
  "blocks_dependents" = 0,
  "claimable" = 0,
  "handoff" = coalesce("handoff", '{"mode":"nobody"}')
WHERE "category" = 'done';--> statement-breakpoint
-- completedAt follows blocks_dependents from now on (it already followed the category).
UPDATE `task` SET "completed_at" = coalesce("completed_at", "updated_at")
WHERE "status_id" IN (SELECT "id" FROM `status` WHERE "blocks_dependents" = 0);--> statement-breakpoint
UPDATE `task` SET "completed_at" = NULL
WHERE "status_id" IN (SELECT "id" FROM `status` WHERE "blocks_dependents" = 1);
