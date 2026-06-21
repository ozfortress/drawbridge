ALTER TABLE `tournament_schedule_settings`
  ADD COLUMN `scheduling_enabled` tinyint(1) NOT NULL DEFAULT 0,
  ADD COLUMN `format` varchar(20) DEFAULT NULL COMMENT 'sixes | highlander | other',
  ADD COLUMN `deadline_day` tinyint(4) DEFAULT NULL COMMENT '0=Mon..6=Sun',
  ADD COLUMN `deadline_time` varchar(10) DEFAULT NULL COMMENT 'e.g. 19:00';

CREATE TABLE `match_schedules` (
  `match_id` int(11) NOT NULL,
  `league_id` int(11) NOT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'pending' COMMENT 'pending | proposed | confirmed',
  `proposed_day` tinyint(4) DEFAULT NULL COMMENT '0=Mon..6=Sun',
  `proposed_time` varchar(10) DEFAULT NULL COMMENT 'e.g. 20:00',
  `proposed_by_team` int(11) DEFAULT NULL COMMENT 'team_id that proposed',
  `proposed_by_user` bigint(20) DEFAULT NULL COMMENT 'discord user id',
  `proposed_at` timestamp NULL DEFAULT NULL,
  `scheduled_at` datetime DEFAULT NULL COMMENT 'UTC, set on confirm',
  `deadline_at` datetime DEFAULT NULL COMMENT 'UTC, computed at generation',
  `deadline_flagged` tinyint(1) NOT NULL DEFAULT 0 COMMENT 'warning already posted',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`match_id`),
  KEY `league_id` (`league_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
