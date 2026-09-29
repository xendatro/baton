-- BAT-36: purely additive. Each member's own sidebar: their team order, pins and folded teams.
ALTER TABLE `team_member` ADD `sidebar_position` integer;--> statement-breakpoint
ALTER TABLE `team_member` ADD `pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `team_member` ADD `sidebar_collapsed` integer DEFAULT false NOT NULL;