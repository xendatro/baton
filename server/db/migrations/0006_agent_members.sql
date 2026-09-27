ALTER TABLE `user` ADD `kind` text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `agent_owner_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `user_agent_owner_id_unique` ON `user` (`agent_owner_id`);