CREATE TABLE `task_approval` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`status_id` text NOT NULL,
	`user_id` text,
	`via_key_id` text,
	`decision` text NOT NULL,
	`comment` text,
	`created_at` integer NOT NULL,
	`dismissed_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`status_id`) REFERENCES `status`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`via_key_id`) REFERENCES `api_key`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `task_approval_task_idx` ON `task_approval` (`task_id`,`status_id`);--> statement-breakpoint
CREATE INDEX `task_approval_status_idx` ON `task_approval` (`status_id`);--> statement-breakpoint
CREATE INDEX `task_approval_user_idx` ON `task_approval` (`user_id`);--> statement-breakpoint
CREATE INDEX `task_approval_via_key_idx` ON `task_approval` (`via_key_id`);--> statement-breakpoint
CREATE TABLE `task_stage_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`status_id` text NOT NULL,
	`entered_at` integer NOT NULL,
	`entered_by_id` text,
	`entered_via_key_id` text,
	`handoff_mode` text,
	`assigned_user_ids` text DEFAULT '[]' NOT NULL,
	`left_at` integer,
	`holder_user_ids` text,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`status_id`) REFERENCES `status`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entered_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`entered_via_key_id`) REFERENCES `api_key`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `task_stage_entry_task_idx` ON `task_stage_entry` (`task_id`,`status_id`,`entered_at`);--> statement-breakpoint
CREATE INDEX `task_stage_entry_status_idx` ON `task_stage_entry` (`status_id`,`entered_at`);--> statement-breakpoint
CREATE INDEX `task_stage_entry_entered_by_idx` ON `task_stage_entry` (`entered_by_id`);--> statement-breakpoint
CREATE INDEX `task_stage_entry_via_key_idx` ON `task_stage_entry` (`entered_via_key_id`);--> statement-breakpoint
CREATE TABLE `task_stage_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`status_id` text NOT NULL,
	`criterion_id` text NOT NULL,
	`text` text NOT NULL,
	`user_id` text,
	`via_key_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`status_id`) REFERENCES `status`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`via_key_id`) REFERENCES `api_key`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_stage_evidence_unique` ON `task_stage_evidence` (`task_id`,`status_id`,`criterion_id`);--> statement-breakpoint
CREATE INDEX `task_stage_evidence_status_idx` ON `task_stage_evidence` (`status_id`);--> statement-breakpoint
CREATE INDEX `task_stage_evidence_user_idx` ON `task_stage_evidence` (`user_id`);--> statement-breakpoint
CREATE INDEX `task_stage_evidence_via_key_idx` ON `task_stage_evidence` (`via_key_id`);--> statement-breakpoint
ALTER TABLE `status` ADD `instructions` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `status` ADD `handoff` text;--> statement-breakpoint
ALTER TABLE `status` ADD `notify` text;--> statement-breakpoint
ALTER TABLE `status` ADD `exit_criteria` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `status` ADD `move_rule` text;--> statement-breakpoint
ALTER TABLE `status` ADD `approvals` text;--> statement-breakpoint
ALTER TABLE `status` ADD `auto_advance` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `status` ADD `next_status_id` text REFERENCES status(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `status` ADD `allow_send_back` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `task` ADD `pool_rule` text;