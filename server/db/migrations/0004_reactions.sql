CREATE TABLE `reaction` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`user_id` text NOT NULL,
	`via_key_id` text,
	`emoji` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`via_key_id`) REFERENCES `api_key`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reaction_target_user_emoji_unique` ON `reaction` (`target_type`,`target_id`,`user_id`,`emoji`);--> statement-breakpoint
CREATE INDEX `reaction_team_idx` ON `reaction` (`team_id`);--> statement-breakpoint
CREATE INDEX `reaction_user_idx` ON `reaction` (`user_id`);--> statement-breakpoint
CREATE INDEX `reaction_via_key_idx` ON `reaction` (`via_key_id`);