CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `activity` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text,
	`project_id` text,
	`actor_id` text,
	`source` text NOT NULL,
	`via_key_id` text,
	`via_key_name` text,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`changes` text DEFAULT '{}' NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_team_created_idx` ON `activity` (`team_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `activity_entity_created_idx` ON `activity` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `activity_actor_created_idx` ON `activity` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `api_key` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_key_hash_unique` ON `api_key` (`hash`);--> statement-breakpoint
CREATE INDEX `api_key_user_idx` ON `api_key` (`user_id`);--> statement-breakpoint
CREATE TABLE `attachment` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text,
	`uploader_id` text,
	`via_key_id` text,
	`parent_type` text NOT NULL,
	`parent_id` text,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`storage_path` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	`deleted_by_id` text,
	`deleted_via_key_id` text,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploader_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`via_key_id`) REFERENCES `api_key`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`deleted_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`deleted_via_key_id`) REFERENCES `api_key`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `attachment_parent_idx` ON `attachment` (`parent_type`,`parent_id`);--> statement-breakpoint
CREATE INDEX `attachment_team_idx` ON `attachment` (`team_id`);--> statement-breakpoint
CREATE INDEX `attachment_uploader_idx` ON `attachment` (`uploader_id`);--> statement-breakpoint
CREATE INDEX `attachment_via_key_idx` ON `attachment` (`via_key_id`);--> statement-breakpoint
CREATE INDEX `attachment_deleted_by_idx` ON `attachment` (`deleted_by_id`);--> statement-breakpoint
CREATE INDEX `attachment_deleted_via_key_idx` ON `attachment` (`deleted_via_key_id`);--> statement-breakpoint
CREATE TABLE `invite` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`code` text NOT NULL,
	`created_by_id` text,
	`max_uses` integer,
	`uses` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invite_code_unique` ON `invite` (`code`);--> statement-breakpoint
CREATE INDEX `invite_team_idx` ON `invite` (`team_id`);--> statement-breakpoint
CREATE INDEX `invite_created_by_idx` ON `invite` (`created_by_id`);--> statement-breakpoint
CREATE TABLE `issue` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`team_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`author_id` text,
	`via_key_id` text,
	`resolved` integer DEFAULT false NOT NULL,
	`resolved_at` integer,
	`resolved_by_id` text,
	`reply_count` integer DEFAULT 0 NOT NULL,
	`last_activity_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`edited_at` integer,
	`deleted_at` integer,
	`deleted_by_id` text,
	`deleted_via_key_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`via_key_id`) REFERENCES `api_key`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resolved_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`deleted_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`deleted_via_key_id`) REFERENCES `api_key`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_project_number_unique` ON `issue` (`project_id`,`number`);--> statement-breakpoint
CREATE INDEX `issue_project_activity_idx` ON `issue` (`project_id`,`last_activity_at`);--> statement-breakpoint
CREATE INDEX `issue_team_idx` ON `issue` (`team_id`);--> statement-breakpoint
CREATE INDEX `issue_author_idx` ON `issue` (`author_id`);--> statement-breakpoint
CREATE INDEX `issue_via_key_idx` ON `issue` (`via_key_id`);--> statement-breakpoint
CREATE INDEX `issue_resolved_by_idx` ON `issue` (`resolved_by_id`);--> statement-breakpoint
CREATE INDEX `issue_deleted_by_idx` ON `issue` (`deleted_by_id`);--> statement-breakpoint
CREATE INDEX `issue_deleted_via_key_idx` ON `issue` (`deleted_via_key_id`);--> statement-breakpoint
CREATE TABLE `issue_label` (
	`issue_id` text NOT NULL,
	`label_id` text NOT NULL,
	PRIMARY KEY(`issue_id`, `label_id`),
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `label`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_label_label_idx` ON `issue_label` (`label_id`);--> statement-breakpoint
CREATE TABLE `label` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `label_project_name_unique` ON `label` (`project_id`,`name`);--> statement-breakpoint
CREATE TABLE `member_role` (
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `role_id`),
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `role`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`,`user_id`) REFERENCES `team_member`(`team_id`,`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `member_role_role_idx` ON `member_role` (`role_id`);--> statement-breakpoint
CREATE INDEX `member_role_member_idx` ON `member_role` (`team_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `notification` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`team_id` text NOT NULL,
	`type` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`actor_id` text,
	`via_key_name` text,
	`title` text NOT NULL,
	`snippet` text DEFAULT '' NOT NULL,
	`url` text NOT NULL,
	`read_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `notification_user_created_idx` ON `notification` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notification_user_read_idx` ON `notification` (`user_id`,`read_at`);--> statement-breakpoint
CREATE INDEX `notification_team_idx` ON `notification` (`team_id`);--> statement-breakpoint
CREATE INDEX `notification_actor_idx` ON `notification` (`actor_id`);--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`name` text NOT NULL,
	`key` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`readme` text DEFAULT '' NOT NULL,
	`icon` text,
	`color` text NOT NULL,
	`issue_seq` integer DEFAULT 0 NOT NULL,
	`task_seq` integer DEFAULT 0 NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`deleted_by_id` text,
	`deleted_via_key_id` text,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`deleted_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`deleted_via_key_id`) REFERENCES `api_key`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_team_key_active_unique` ON `project` (`team_id`,`key`) WHERE "project"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `project_team_idx` ON `project` (`team_id`);--> statement-breakpoint
CREATE INDEX `project_created_by_idx` ON `project` (`created_by_id`);--> statement-breakpoint
CREATE INDEX `project_deleted_by_idx` ON `project` (`deleted_by_id`);--> statement-breakpoint
CREATE INDEX `project_deleted_via_key_idx` ON `project` (`deleted_via_key_id`);--> statement-breakpoint
CREATE TABLE `project_key_alias` (
	`project_id` text NOT NULL,
	`team_id` text NOT NULL,
	`key` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `key`),
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_key_alias_team_key_idx` ON `project_key_alias` (`team_id`,`key`);--> statement-breakpoint
CREATE TABLE `reply` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`project_id` text NOT NULL,
	`parent_type` text NOT NULL,
	`parent_id` text NOT NULL,
	`author_id` text,
	`via_key_id` text,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`edited_at` integer,
	`deleted_at` integer,
	`deleted_by_id` text,
	`deleted_via_key_id` text,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`via_key_id`) REFERENCES `api_key`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`deleted_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`deleted_via_key_id`) REFERENCES `api_key`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `reply_parent_idx` ON `reply` (`parent_type`,`parent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `reply_team_idx` ON `reply` (`team_id`);--> statement-breakpoint
CREATE INDEX `reply_project_idx` ON `reply` (`project_id`);--> statement-breakpoint
CREATE INDEX `reply_author_idx` ON `reply` (`author_id`);--> statement-breakpoint
CREATE INDEX `reply_via_key_idx` ON `reply` (`via_key_id`);--> statement-breakpoint
CREATE INDEX `reply_deleted_by_idx` ON `reply` (`deleted_by_id`);--> statement-breakpoint
CREATE INDEX `reply_deleted_via_key_idx` ON `reply` (`deleted_via_key_id`);--> statement-breakpoint
CREATE TABLE `role` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`color` text,
	`position` integer NOT NULL,
	`permissions` text DEFAULT '[]' NOT NULL,
	`mentionable` integer DEFAULT false NOT NULL,
	`is_everyone` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_team_slug_unique` ON `role` (`team_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `role_team_everyone_unique` ON `role` (`team_id`) WHERE "role"."is_everyone" = 1;--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `status` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`category` text NOT NULL,
	`position` integer NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `status_project_name_unique` ON `status` (`project_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `status_project_default_unique` ON `status` (`project_id`) WHERE "status"."is_default" = 1;--> statement-breakpoint
CREATE TABLE `subscription` (
	`user_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`subscribed` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `entity_type`, `entity_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `subscription_entity_idx` ON `subscription` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `task` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`team_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status_id` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`due_date` text,
	`position` text NOT NULL,
	`author_id` text,
	`via_key_id` text,
	`claimed_by_id` text,
	`claimed_via_key_id` text,
	`claimed_at` integer,
	`claim_expires_at` integer,
	`completed_at` integer,
	`reply_count` integer DEFAULT 0 NOT NULL,
	`last_activity_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`edited_at` integer,
	`deleted_at` integer,
	`deleted_by_id` text,
	`deleted_via_key_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`status_id`) REFERENCES `status`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`via_key_id`) REFERENCES `api_key`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`claimed_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`claimed_via_key_id`) REFERENCES `api_key`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`deleted_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`deleted_via_key_id`) REFERENCES `api_key`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_project_number_unique` ON `task` (`project_id`,`number`);--> statement-breakpoint
CREATE INDEX `task_status_position_idx` ON `task` (`status_id`,`position`);--> statement-breakpoint
CREATE INDEX `task_team_idx` ON `task` (`team_id`);--> statement-breakpoint
CREATE INDEX `task_author_idx` ON `task` (`author_id`);--> statement-breakpoint
CREATE INDEX `task_via_key_idx` ON `task` (`via_key_id`);--> statement-breakpoint
CREATE INDEX `task_claimed_by_idx` ON `task` (`claimed_by_id`);--> statement-breakpoint
CREATE INDEX `task_claimed_via_key_idx` ON `task` (`claimed_via_key_id`);--> statement-breakpoint
CREATE INDEX `task_claim_expires_idx` ON `task` (`claim_expires_at`);--> statement-breakpoint
CREATE INDEX `task_deleted_by_idx` ON `task` (`deleted_by_id`);--> statement-breakpoint
CREATE INDEX `task_deleted_via_key_idx` ON `task` (`deleted_via_key_id`);--> statement-breakpoint
CREATE TABLE `task_assignee_role` (
	`task_id` text NOT NULL,
	`role_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `role_id`),
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `role`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_assignee_role_role_idx` ON `task_assignee_role` (`role_id`);--> statement-breakpoint
CREATE TABLE `task_assignee_user` (
	`task_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `user_id`),
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_assignee_user_user_idx` ON `task_assignee_user` (`user_id`);--> statement-breakpoint
CREATE TABLE `task_dependency` (
	`task_id` text NOT NULL,
	`blocked_by_task_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`task_id`, `blocked_by_task_id`),
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blocked_by_task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_dependency_not_self" CHECK("task_dependency"."task_id" <> "task_dependency"."blocked_by_task_id")
);
--> statement-breakpoint
CREATE INDEX `task_dependency_blocked_by_idx` ON `task_dependency` (`blocked_by_task_id`);--> statement-breakpoint
CREATE TABLE `task_issue_link` (
	`task_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`task_id`, `issue_id`),
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_issue_link_issue_idx` ON `task_issue_link` (`issue_id`);--> statement-breakpoint
CREATE TABLE `task_label` (
	`task_id` text NOT NULL,
	`label_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `label_id`),
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `label`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_label_label_idx` ON `task_label` (`label_id`);--> statement-breakpoint
CREATE TABLE `team` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`icon` text,
	`color` text NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`deleted_by_id` text,
	`deleted_via_key_id` text,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`deleted_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`deleted_via_key_id`) REFERENCES `api_key`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_slug_active_unique` ON `team` (`slug`) WHERE "team"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `team_owner_idx` ON `team` (`owner_id`);--> statement-breakpoint
CREATE INDEX `team_deleted_by_idx` ON `team` (`deleted_by_id`);--> statement-breakpoint
CREATE INDEX `team_deleted_via_key_idx` ON `team` (`deleted_via_key_id`);--> statement-breakpoint
CREATE TABLE `team_member` (
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`team_id`, `user_id`),
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `team_member_user_idx` ON `team_member` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`username` text,
	`display_username` text,
	`theme` text DEFAULT 'system' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_username_unique` ON `user` (`username`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);