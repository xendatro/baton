-- Additive only (BAT-34): a person's notification overrides for one team, between the project's
-- override and the account's settings. A new table; nothing existing changes.
CREATE TABLE `team_member_settings` (
	`user_id` text NOT NULL,
	`team_id` text NOT NULL,
	`notifications` text,
	`agent_notifications` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `team_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `team_member_settings_team_idx` ON `team_member_settings` (`team_id`);