-- Purely additive. Each person pins projects (not teams) to the top of their sidebar, in their order.
CREATE TABLE `project_pin` (
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `project_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_pin_project_idx` ON `project_pin` (`project_id`);--> statement-breakpoint
-- Team pins (BAT-36) are gone: clear them (the column stays, unused, to avoid a table rebuild).
UPDATE `team_member` SET `pinned` = 0 WHERE `pinned` = 1;
