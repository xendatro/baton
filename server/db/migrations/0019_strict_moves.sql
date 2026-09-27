-- BAT-27, hand-written: purely additive (no table is rebuilt; dropping a parent table inside the
-- migration's transaction would cascade into its child rows).
-- Evidence is per visit: an earlier visit's evidence is archived, so only current rows are unique.
DROP INDEX `task_stage_evidence_unique`;--> statement-breakpoint
ALTER TABLE `task_stage_evidence` ADD `archived_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `task_stage_evidence_current_unique` ON `task_stage_evidence` (`task_id`,`status_id`,`criterion_id`) WHERE "task_stage_evidence"."archived_at" is null;--> statement-breakpoint
-- The stages each stage may send tasks back to: every earlier stage of its pipeline when it
-- allowed sending back, else none.
ALTER TABLE `status` ADD `send_back_to` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
UPDATE `status` SET `send_back_to` = (
  SELECT json_group_array(`id`) FROM (
    SELECT `e`.`id` FROM `status` `e`
    WHERE `e`.`pipeline_id` = `status`.`pipeline_id`
      AND (`e`.`position` < `status`.`position` OR (`e`.`position` = `status`.`position` AND (`e`.`created_at` < `status`.`created_at` OR (`e`.`created_at` = `status`.`created_at` AND `e`.`id` < `status`.`id`))))
    ORDER BY `e`.`position`, `e`.`created_at`, `e`.`id`
  )
) WHERE `allow_send_back` = 1;--> statement-breakpoint
-- Why a task came back to a stage.
ALTER TABLE `task_stage_entry` ADD `return_reason` text;--> statement-breakpoint
ALTER TABLE `task_stage_entry` ADD `returned_by_id` text REFERENCES user(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `task_stage_entry` ADD `returned_via_key_id` text REFERENCES api_key(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `task_stage_entry` ADD `returned_from_status_id` text REFERENCES status(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `task_stage_entry_returned_by_idx` ON `task_stage_entry` (`returned_by_id`);--> statement-breakpoint
CREATE INDEX `task_stage_entry_returned_via_key_idx` ON `task_stage_entry` (`returned_via_key_id`);--> statement-breakpoint
CREATE INDEX `task_stage_entry_returned_from_idx` ON `task_stage_entry` (`returned_from_status_id`);
