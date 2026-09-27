CREATE TABLE `agent_job` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_user_id` text NOT NULL,
	`team_id` text NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`trigger_reply_id` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`closing` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`session_id` text,
	`created_at` integer NOT NULL,
	`claimed_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`agent_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trigger_reply_id`) REFERENCES `reply`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_id`) REFERENCES `agent_session`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agent_job_agent_status_idx` ON `agent_job` (`agent_user_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_job_target_idx` ON `agent_job` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `agent_job_session_idx` ON `agent_job` (`session_id`);--> statement-breakpoint
CREATE INDEX `agent_job_team_idx` ON `agent_job` (`team_id`);--> statement-breakpoint
CREATE INDEX `agent_job_project_idx` ON `agent_job` (`project_id`);--> statement-breakpoint
CREATE INDEX `agent_job_trigger_reply_idx` ON `agent_job` (`trigger_reply_id`);--> statement-breakpoint
CREATE TABLE `agent_session` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_user_id` text NOT NULL,
	`key_id` text,
	`project_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`agent_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`key_id`) REFERENCES `api_key`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agent_session_agent_idx` ON `agent_session` (`agent_user_id`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `agent_session_key_idx` ON `agent_session` (`key_id`);--> statement-breakpoint
CREATE TABLE `agent_thread` (
	`parent_type` text NOT NULL,
	`parent_id` text NOT NULL,
	`loop_guard_at` integer,
	`closed_at` integer,
	PRIMARY KEY(`parent_type`, `parent_id`)
);
--> statement-breakpoint
ALTER TABLE `reply` ADD `closing` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `role` ADD `hoist` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- BAT-6/agents A mentions still waiting for a key become one pending mention job per agent and item.
INSERT INTO `agent_job` (`id`, `agent_user_id`, `team_id`, `project_id`, `kind`, `target_type`, `target_id`, `trigger_reply_id`, `payload`, `closing`, `status`, `created_at`)
SELECT min(m.`id`), a.`id`, m.`team_id`, r.`project_id`, 'mention', m.`parent_type`, m.`parent_id`, max(m.`reply_id`), '{}', 0, 'pending', min(m.`created_at`)
FROM `agent_mention` m
JOIN `api_key` k ON k.`id` = m.`key_id`
JOIN `user` a ON a.`agent_owner_id` = k.`user_id` AND a.`kind` = 'agent'
JOIN `reply` r ON r.`id` = m.`reply_id`
WHERE m.`delivered_at` IS NULL
GROUP BY a.`id`, m.`team_id`, r.`project_id`, m.`parent_type`, m.`parent_id`;--> statement-breakpoint
DROP TABLE `agent_mention`;
