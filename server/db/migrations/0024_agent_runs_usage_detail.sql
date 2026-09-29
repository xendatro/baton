ALTER TABLE `agent_job` ADD `held_at` integer;--> statement-breakpoint
ALTER TABLE `agent_job` ADD `run_outcome` text;--> statement-breakpoint
ALTER TABLE `agent_job` ADD `run_error` text;--> statement-breakpoint
ALTER TABLE `agent_job` ADD `run_output` text;--> statement-breakpoint
ALTER TABLE `agent_job` ADD `run_ended_at` integer;--> statement-breakpoint
ALTER TABLE `agent_job` ADD `cleared_at` integer;--> statement-breakpoint
ALTER TABLE `agent_job` ADD `cleared_reason` text;--> statement-breakpoint
ALTER TABLE `agent_usage` ADD `reported_model` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_usage` ADD `tokens_cache_read` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_usage` ADD `tokens_cache_write` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_usage` ADD `tokens_reasoning` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_usage` ADD `error` text;--> statement-breakpoint
-- BAT#22: jobs already held after a failed or killed run (they have a usage row, or were caused by
-- the owner or their agent, whose jobs never wait for an OK otherwise) become "Stopped runs".
UPDATE `agent_job` SET `held_at` = coalesce(
  (SELECT max(`u`.`created_at`) FROM `agent_usage` `u` WHERE `u`.`job_id` = `agent_job`.`id`),
  `agent_job`.`created_at`
)
WHERE `status` = 'pending' AND `needs_ok` = 1 AND (
  EXISTS (SELECT 1 FROM `agent_usage` `u` WHERE `u`.`job_id` = `agent_job`.`id`)
  OR `triggered_by_id` IS NULL
  OR `triggered_by_id` = `agent_user_id`
  OR `triggered_by_id` = (SELECT `a`.`agent_owner_id` FROM `user` `a` WHERE `a`.`id` = `agent_job`.`agent_user_id`)
);--> statement-breakpoint
UPDATE `agent_job` SET
  `run_outcome` = (SELECT `u`.`outcome` FROM `agent_usage` `u` WHERE `u`.`job_id` = `agent_job`.`id` ORDER BY `u`.`created_at` DESC, `u`.`id` DESC LIMIT 1),
  `run_ended_at` = (SELECT max(`u`.`created_at`) FROM `agent_usage` `u` WHERE `u`.`job_id` = `agent_job`.`id`)
WHERE `held_at` IS NOT NULL AND EXISTS (SELECT 1 FROM `agent_usage` `u` WHERE `u`.`job_id` = `agent_job`.`id`);
