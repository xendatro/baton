CREATE TABLE `project_member_settings` (
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`notifications` text,
	`agent_notifications` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `project_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_member_settings_project_idx` ON `project_member_settings` (`project_id`);