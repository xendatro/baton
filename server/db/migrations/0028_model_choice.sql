-- Additive only (difficulty was removed from the product, 2026-09-29; its tables and columns stay,
-- unread). A project's own default model chain, a stage's suggested model, a reply's suggested model.
ALTER TABLE `agent_project_mapping` ADD `chain` text;--> statement-breakpoint
ALTER TABLE `reply` ADD `suggested_model` text;--> statement-breakpoint
ALTER TABLE `status` ADD `suggested_model` text;--> statement-breakpoint
-- Each person's per-project models by difficulty become one default chain per project: the chain
-- of the level named "Normal" when it is mapped, else of the mapped level closest to the middle of
-- the project's levels (by position; on a tie the easier one). Only non-empty chains of levels that
-- still exist count; without one the project uses the account default (chain stays null). The
-- `levels` column keeps the old mapping.
UPDATE `agent_project_mapping` SET `chain` = (
	SELECT json(`j`.`value`)
	FROM json_each(`agent_project_mapping`.`levels`) AS `j`
	INNER JOIN `difficulty` AS `d`
		ON `d`.`id` = `j`.`key` AND `d`.`project_id` = `agent_project_mapping`.`project_id`
	WHERE `j`.`type` = 'array' AND json_array_length(`j`.`value`) > 0
	ORDER BY
		(lower(trim(`d`.`name`)) = 'normal') DESC,
		abs(2 * `d`.`position` - (
			SELECT min(`e`.`position`) + max(`e`.`position`)
			FROM `difficulty` AS `e`
			WHERE `e`.`project_id` = `d`.`project_id`
		)) ASC,
		`d`.`position` ASC
	LIMIT 1
)
WHERE json_valid(`levels`);
