ALTER TABLE `project` ADD `agents_paused_at` integer;--> statement-breakpoint
ALTER TABLE `team` ADD `agents_paused_at` integer;--> statement-breakpoint
ALTER TABLE `user` ADD `agent_paused_at` integer;--> statement-breakpoint
ALTER TABLE `user` ADD `agent_notifications` text DEFAULT 'needs_me' NOT NULL;