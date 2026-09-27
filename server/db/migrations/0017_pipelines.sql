CREATE TABLE `pipeline` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`color` text,
	`icon` text,
	`position` integer NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`view_rule` text,
	`create_rule` text,
	`manage_rule` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`deleted_by_id` text,
	`deleted_via_key_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deleted_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`deleted_via_key_id`) REFERENCES `api_key`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pipeline_project_slug_active_unique` ON `pipeline` (`project_id`,`slug`) WHERE "pipeline"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `pipeline_project_default_unique` ON `pipeline` (`project_id`) WHERE "pipeline"."is_default" = 1;--> statement-breakpoint
CREATE INDEX `pipeline_project_idx` ON `pipeline` (`project_id`);--> statement-breakpoint
-- BAT-25, hand-written: purely additive. No table is rebuilt (dropping `status` inside the
-- migration's transaction would cascade into assignments, stage entries and evidence), so the
-- new column is added nullable, filled, and kept non-null by triggers.
-- Every project gets its reserved Default pipeline, soft-deleted projects included.
INSERT INTO `pipeline` (`id`, `project_id`, `name`, `slug`, `color`, `icon`, `position`, `is_default`, `view_rule`, `create_rule`, `manage_rule`, `created_at`, `updated_at`)
SELECT 'pl' || lower(hex(randomblob(12))), `id`, 'Default', 'default', NULL, NULL, 0, 1, NULL, NULL, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `project`;--> statement-breakpoint
ALTER TABLE `status` ADD `pipeline_id` text REFERENCES pipeline(id);--> statement-breakpoint
UPDATE `status` SET `pipeline_id` = (SELECT `p`.`id` FROM `pipeline` `p` WHERE `p`.`project_id` = `status`.`project_id` AND `p`.`is_default` = 1);--> statement-breakpoint
CREATE TRIGGER `status_pipeline_required_insert` BEFORE INSERT ON `status` FOR EACH ROW WHEN NEW.`pipeline_id` IS NULL BEGIN SELECT RAISE(ABORT, 'status.pipeline_id is required'); END;--> statement-breakpoint
CREATE TRIGGER `status_pipeline_required_update` BEFORE UPDATE OF `pipeline_id` ON `status` FOR EACH ROW WHEN NEW.`pipeline_id` IS NULL BEGIN SELECT RAISE(ABORT, 'status.pipeline_id is required'); END;--> statement-breakpoint
DROP INDEX `status_project_name_unique`;--> statement-breakpoint
DROP INDEX `status_project_default_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `status_pipeline_name_unique` ON `status` (`pipeline_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `status_pipeline_default_unique` ON `status` (`pipeline_id`) WHERE "status"."is_default" = 1;--> statement-breakpoint
CREATE INDEX `status_project_idx` ON `status` (`project_id`);