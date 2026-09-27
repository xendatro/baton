-- BAT-34, hand-written: purely additive (no table is rebuilt; dropping a parent table inside the
-- migration's transaction would cascade into its child rows).
-- A stage rule: new tasks can start here. Off for new stages; each pipeline's default stage gets
-- it, so tasks keep starting where they did.
ALTER TABLE `status` ADD `allow_create` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `status` SET `allow_create` = 1 WHERE `is_default` = 1;--> statement-breakpoint
-- A pipeline without a marked default started new tasks in its first stage.
UPDATE `status` SET `allow_create` = 1
WHERE NOT EXISTS (SELECT 1 FROM `status` `d` WHERE `d`.`pipeline_id` = `status`.`pipeline_id` AND `d`.`is_default` = 1)
AND `position` = (SELECT min(`m`.`position`) FROM `status` `m` WHERE `m`.`pipeline_id` = `status`.`pipeline_id`);
