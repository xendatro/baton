-- BAT-28, hand-written: purely additive (no table is rebuilt; dropping a parent table inside the
-- migration's transaction would cascade into its child rows).
-- A task's difficulty per stage, like its assignments there.
CREATE TABLE `task_stage_difficulty` (
	`task_id` text NOT NULL,
	`status_id` text NOT NULL,
	`difficulty_id` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`task_id`, `status_id`),
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`status_id`) REFERENCES `status`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`difficulty_id`) REFERENCES `difficulty`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `task_stage_difficulty_status_idx` ON `task_stage_difficulty` (`status_id`);--> statement-breakpoint
CREATE INDEX `task_stage_difficulty_difficulty_idx` ON `task_stage_difficulty` (`difficulty_id`);--> statement-breakpoint
-- Every task's current difficulty becomes its current stage's (soft-deleted tasks included).
INSERT INTO `task_stage_difficulty` (`task_id`, `status_id`, `difficulty_id`, `updated_at`)
SELECT `id`, `status_id`, `difficulty_id`, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM `task`;--> statement-breakpoint
-- Stage defaults start empty: nothing changes until someone sets them.
ALTER TABLE `status` ADD `default_difficulty_id` text REFERENCES difficulty(id) ON DELETE set null;--> statement-breakpoint
-- The difficulty of each visit (stage history); the current visits get the task's.
ALTER TABLE `task_stage_entry` ADD `difficulty_id` text REFERENCES difficulty(id) ON DELETE set null;--> statement-breakpoint
UPDATE `task_stage_entry` SET `difficulty_id` = (SELECT `t`.`difficulty_id` FROM `task` `t` WHERE `t`.`id` = `task_stage_entry`.`task_id`)
WHERE `left_at` IS NULL AND `status_id` = (SELECT `t`.`status_id` FROM `task` `t` WHERE `t`.`id` = `task_stage_entry`.`task_id`);--> statement-breakpoint
CREATE INDEX `task_stage_entry_difficulty_idx` ON `task_stage_entry` (`difficulty_id`);
