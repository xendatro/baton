CREATE TABLE `github_installation` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`installation_id` integer NOT NULL,
	`account_login` text NOT NULL,
	`account_type` text NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_installation_team_unique` ON `github_installation` (`team_id`,`installation_id`);--> statement-breakpoint
CREATE INDEX `github_installation_created_by_idx` ON `github_installation` (`created_by_id`);--> statement-breakpoint
ALTER TABLE `project` ADD `readme_source` text;