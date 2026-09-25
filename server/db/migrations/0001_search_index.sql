-- Full-text search over tasks, issues and replies (SPEC §4). Maintained by the service layer
-- (server/services/search.ts) in the same transaction as the indexed change; queried with raw SQL.
-- All filter columns are UNINDEXED so MATCH only considers title and body; filter them with `=`/IN.
CREATE VIRTUAL TABLE `search_index` USING fts5(
	`entity_type` UNINDEXED,
	`entity_id` UNINDEXED,
	`team_id` UNINDEXED,
	`project_id` UNINDEXED,
	`title`,
	`body`,
	tokenize = 'porter unicode61 remove_diacritics 2',
	prefix = '2 3'
);
