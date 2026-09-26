CREATE TABLE `agent_mention` (
	`id` text PRIMARY KEY NOT NULL,
	`key_id` text NOT NULL,
	`team_id` text NOT NULL,
	`reply_id` text NOT NULL,
	`parent_type` text NOT NULL,
	`parent_id` text NOT NULL,
	`delivered_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`key_id`) REFERENCES `api_key`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reply_id`) REFERENCES `reply`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_mention_key_idx` ON `agent_mention` (`key_id`,`delivered_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_mention_key_reply_unique` ON `agent_mention` (`key_id`,`reply_id`);--> statement-breakpoint
ALTER TABLE `api_key` ADD `agent_name` text;--> statement-breakpoint
ALTER TABLE `notification` ADD `via_agent_name` text;