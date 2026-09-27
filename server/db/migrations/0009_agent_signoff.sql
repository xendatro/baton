CREATE TABLE `agent_action_request` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`project_id` text,
	`agent_user_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`action` text NOT NULL,
	`payload` text NOT NULL,
	`source` text NOT NULL,
	`via_key_id` text,
	`via_key_name` text,
	`via_agent_name` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`result` text,
	`error` text,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by_id` text,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decided_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agent_action_request_owner_idx` ON `agent_action_request` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_action_request_status_idx` ON `agent_action_request` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_action_request_agent_idx` ON `agent_action_request` (`agent_user_id`);--> statement-breakpoint
CREATE INDEX `agent_action_request_team_idx` ON `agent_action_request` (`team_id`);--> statement-breakpoint
CREATE INDEX `agent_action_request_project_idx` ON `agent_action_request` (`project_id`);--> statement-breakpoint
CREATE INDEX `agent_action_request_key_idx` ON `agent_action_request` (`via_key_id`);--> statement-breakpoint
CREATE INDEX `agent_action_request_decided_by_idx` ON `agent_action_request` (`decided_by_id`);--> statement-breakpoint
ALTER TABLE `team` ADD `agent_signoff` integer DEFAULT true NOT NULL;