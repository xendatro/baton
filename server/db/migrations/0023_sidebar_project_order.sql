-- BAT#27: purely additive. Each person's own order of a team's projects in their sidebar.
CREATE TABLE `sidebar_project_order` (
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`user_id`, `project_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sidebar_project_order_project_idx` ON `sidebar_project_order` (`project_id`);