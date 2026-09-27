CREATE TABLE `project_permission_override` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`allow` text DEFAULT '[]' NOT NULL,
	`deny` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_permission_override_subject_unique` ON `project_permission_override` (`project_id`,`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `project_permission_override_subject_idx` ON `project_permission_override` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `project_role` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`color` text,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_role_project_slug_unique` ON `project_role` (`project_id`,`slug`);--> statement-breakpoint
CREATE TABLE `project_role_member` (
	`project_role_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`project_role_id`, `user_id`),
	FOREIGN KEY (`project_role_id`) REFERENCES `project_role`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_role_member_user_idx` ON `project_role_member` (`user_id`);--> statement-breakpoint
-- Project permissions (docs/design/agents-and-pipelines.md §3): every existing @everyone role
-- gets the new VIEW_PROJECT (so all projects stay visible) and loses CREATE_INVITES (the new
-- default). Other roles are untouched. Permissions are re-sorted by the app when read.
UPDATE `role` SET `permissions` = (
	SELECT json_group_array(`value`) FROM (
		SELECT `value` FROM json_each(`role`.`permissions`) WHERE `value` <> 'CREATE_INVITES'
		UNION SELECT 'VIEW_PROJECT'
	)
) WHERE `is_everyone` = 1;
