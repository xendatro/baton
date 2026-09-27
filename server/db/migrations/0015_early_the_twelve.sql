CREATE TABLE `difficulty` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `difficulty_project_name_unique` ON `difficulty` (`project_id`,`name`);--> statement-breakpoint
CREATE INDEX `difficulty_project_idx` ON `difficulty` (`project_id`);--> statement-breakpoint
ALTER TABLE `task` ADD `difficulty_id` text REFERENCES difficulty(id) ON DELETE set null;--> statement-breakpoint
INSERT INTO `difficulty` (`id`, `project_id`, `name`, `color`, `position`, `created_at`, `updated_at`)
SELECT 'd' || lower(hex(randomblob(12))), `p`.`id`, `l`.`name`, `l`.`color`, `l`.`position`, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `project` `p`
CROSS JOIN (SELECT 'Easy' AS `name`, '#22c55e' AS `color`, 0 AS `position` UNION ALL SELECT 'Normal', '#3b82f6', 1 UNION ALL SELECT 'Hard', '#ef4444', 2) `l`;