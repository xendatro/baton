CREATE TABLE `agent_access` (
	`owner_id` text NOT NULL,
	`team_id` text NOT NULL,
	`project_id` text,
	`rules` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_access_team_default_unique` ON `agent_access` (`owner_id`,`team_id`) WHERE "agent_access"."project_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_access_project_unique` ON `agent_access` (`owner_id`,`project_id`) WHERE "agent_access"."project_id" is not null;--> statement-breakpoint
CREATE INDEX `agent_access_team_idx` ON `agent_access` (`team_id`);--> statement-breakpoint
CREATE INDEX `agent_access_project_idx` ON `agent_access` (`project_id`);--> statement-breakpoint
ALTER TABLE `agent_job` ADD `model_override` text;--> statement-breakpoint
ALTER TABLE `agent_job` ADD `request_decision` text;--> statement-breakpoint
ALTER TABLE `agent_job` ADD `request_decided_at` integer;--> statement-breakpoint
ALTER TABLE `agent_job` ADD `request_reason` text;--> statement-breakpoint
-- Agent access replaces "Whose jobs run" (agent_settings.job_sources). Each owner who let more
-- than their own jobs run gets a team default in every team they belong to, with those people in
-- "Start automatically" and everyone else in "Can ask you", so nothing behaves differently:
-- `anyone` → every person and agent starts it; `custom` → its rule starts it and every person and
-- agent may ask (minus an @everyone its rule already has). `me` (or nothing) is the built-in
-- default and needs no row.
INSERT INTO `agent_access` (`owner_id`, `team_id`, `project_id`, `rules`, `updated_at`)
SELECT `s`.`user_id`, `tm`.`team_id`, NULL,
  CASE json_extract(`s`.`job_sources`, '$.mode')
    WHEN 'anyone' THEN json_object(
      'auto', json_object('allow', json_array(
        json_object('type', 'everyone', 'scope', 'people'),
        json_object('type', 'everyone', 'scope', 'agents')), 'deny', json_array()),
      'ask', json_object('allow', json_array(), 'deny', json_array()))
    ELSE json_object(
      'auto', json_object(
        'allow', json(coalesce(json_extract(`s`.`job_sources`, '$.rule.allow'), '[]')),
        'deny', json(coalesce(json_extract(`s`.`job_sources`, '$.rule.deny'), '[]'))),
      'ask', json_object(
        'allow', json((
          SELECT json_group_array(json_object('type', 'everyone', 'scope', `e`.`scope`))
          FROM (SELECT 'people' AS `scope` UNION ALL SELECT 'agents') `e`
          WHERE NOT EXISTS (
            SELECT 1 FROM json_each(json_extract(`s`.`job_sources`, '$.rule.allow')) `a`
            WHERE json_extract(`a`.`value`, '$.type') = 'everyone'
              AND json_extract(`a`.`value`, '$.scope') IN (`e`.`scope`, 'both')
          )
        )),
        'deny', json_array()))
  END,
  `s`.`updated_at`
FROM `agent_settings` `s`
INNER JOIN `user` `u` ON `u`.`id` = `s`.`user_id` AND `u`.`kind` = 'human'
INNER JOIN `team_member` `tm` ON `tm`.`user_id` = `s`.`user_id`
WHERE json_extract(`s`.`job_sources`, '$.mode') = 'anyone'
  OR (json_extract(`s`.`job_sources`, '$.mode') = 'custom'
    AND json_array_length(json_extract(`s`.`job_sources`, '$.rule.allow')) > 0);