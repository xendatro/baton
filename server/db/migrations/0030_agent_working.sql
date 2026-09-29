-- Additive only (BAT#42): the jobs whose harness a desktop runner reports running now, and when its
-- last heartbeat reported them ("Ethan AI is working").
ALTER TABLE `agent_session` ADD `running_job_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_session` ADD `running_reported_at` integer;
