-- Chat conversations: each issue and task says how its replies are shown. Existing ones keep the
-- threaded forum view ('forum'); new ones get 'chat' from the create services. Additive only (no
-- table rebuilds). catch_up_summary: private summaries a person's own agent wrote for them.
CREATE TABLE `catch_up_summary` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`item_type` text NOT NULL,
	`item_id` text NOT NULL,
	`job_id` text,
	`range` text NOT NULL,
	`summary` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `agent_job`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `catch_up_summary_user_item_idx` ON `catch_up_summary` (`user_id`,`item_type`,`item_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `catch_up_summary_project_idx` ON `catch_up_summary` (`project_id`);--> statement-breakpoint
CREATE INDEX `catch_up_summary_job_idx` ON `catch_up_summary` (`job_id`);--> statement-breakpoint
ALTER TABLE `issue` ADD `conversation_mode` text DEFAULT 'forum' NOT NULL;--> statement-breakpoint
ALTER TABLE `task` ADD `conversation_mode` text DEFAULT 'forum' NOT NULL;