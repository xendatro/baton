CREATE TABLE `agent_harness_session` (
	`agent_user_id` text NOT NULL,
	`task_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`harness` text NOT NULL,
	`session_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`agent_user_id`, `task_id`, `machine_id`, `harness`),
	FOREIGN KEY (`agent_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_harness_session_task_idx` ON `agent_harness_session` (`task_id`);--> statement-breakpoint
CREATE TABLE `agent_project_mapping` (
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`levels` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `project_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_project_mapping_project_idx` ON `agent_project_mapping` (`project_id`);--> statement-breakpoint
CREATE TABLE `agent_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`job_sources` text,
	`default_mapping` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`agent_user_id` text NOT NULL,
	`job_id` text,
	`project_id` text,
	`difficulty` text,
	`harness` text NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`effort` text DEFAULT '' NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`cost_micros` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`outcome` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `agent_job`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agent_usage_owner_created_idx` ON `agent_usage` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_usage_job_idx` ON `agent_usage` (`job_id`);--> statement-breakpoint
CREATE INDEX `agent_usage_agent_idx` ON `agent_usage` (`agent_user_id`);--> statement-breakpoint
CREATE INDEX `agent_usage_project_idx` ON `agent_usage` (`project_id`);--> statement-breakpoint
ALTER TABLE `agent_job` ADD `triggered_by_id` text REFERENCES user(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `agent_job` ADD `needs_ok` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_session` ADD `kind` text DEFAULT 'listener' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_session` ADD `machine_id` text;--> statement-breakpoint
ALTER TABLE `agent_session` ADD `machine_name` text;--> statement-breakpoint
ALTER TABLE `agent_session` ADD `harnesses` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_session` ADD `running` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `project` ADD `repo_url` text;