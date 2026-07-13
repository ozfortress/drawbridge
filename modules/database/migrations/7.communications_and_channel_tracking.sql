ALTER TABLE `logs`
  ADD COLUMN IF NOT EXISTS `role_type` varchar(20) DEFAULT NULL COMMENT 'admin, staff, caster, captain_home, captain_away, player, unknown' AFTER `log_type`,
  ADD COLUMN IF NOT EXISTS `channel_id` bigint(20) DEFAULT NULL COMMENT 'Discord channel snowflake' AFTER `role_type`;

CREATE TABLE IF NOT EXISTS `tracked_channels` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `channel_id` bigint(20) NOT NULL COMMENT 'Discord channel snowflake',
  `channel_type` varchar(10) NOT NULL COMMENT 'match or team',
  `match_id` int(11) DEFAULT NULL,
  `team_id` int(11) DEFAULT NULL,
  `league_id` int(11) DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_tc_channel` (`channel_id`),
  KEY `idx_tc_type` (`channel_type`),
  KEY `idx_tc_match` (`match_id`),
  KEY `idx_tc_team` (`team_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
