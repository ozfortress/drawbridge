-- Initial Database Schema for Drawbridge
-- Assumes an empty database

-- schema_migrations definition

CREATE TABLE `schema_migrations` (
  `version` int(11) NOT NULL,
  `applied_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- leagues definition

CREATE TABLE `leagues` (
  `league_id` int(11) NOT NULL,
  `league_name` varchar(100) DEFAULT NULL,
  `league_shortcode` varchar(100) DEFAULT NULL,
  PRIMARY KEY (`league_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- divisions definition

CREATE TABLE `divisions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `division_name` varchar(100) DEFAULT NULL,
  `league_id` int(11) DEFAULT NULL,
  `role_id` bigint(20) DEFAULT NULL,
  `category_id` bigint(20) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- teams definition

CREATE TABLE `teams` (
  `roster_id` int(11) NOT NULL,
  `team_id` int(11) DEFAULT NULL,
  `league_id` int(11) DEFAULT NULL,
  `role_id` bigint(20) DEFAULT NULL,
  `team_name` varchar(100) DEFAULT NULL,
  `team_channel` bigint(20) DEFAULT NULL,
  `division` int(11) DEFAULT NULL,
  PRIMARY KEY (`roster_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- matches definition

CREATE TABLE `matches` (
  `match_id` int(11) NOT NULL,
  `division` int(11) DEFAULT NULL,
  `team_home` int(11) DEFAULT NULL,
  `team_away` int(11) DEFAULT NULL,
  `channel_id` bigint(20) DEFAULT NULL,
  `archived` tinyint(1) DEFAULT NULL,
  `league_id` int(11) DEFAULT NULL,
  PRIMARY KEY (`match_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- users definition

CREATE TABLE `users` (
  `discord_id` bigint(20) NOT NULL,
  `steam_id` varchar(255) NOT NULL,
  `ozfortress_id` int(11) NOT NULL,
  PRIMARY KEY (`discord_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- logs definition

CREATE TABLE `logs` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `match_id` int(11) DEFAULT NULL,
  `team_id` int(11) DEFAULT NULL,
  `user_id` bigint(20) DEFAULT NULL,
  `user_name` varchar(32) DEFAULT NULL,
  `user_nick` varchar(32) DEFAULT NULL,
  `user_avatar` varchar(255) DEFAULT NULL,
  `message_id` bigint(20) DEFAULT NULL,
  `message_content` varchar(3000) DEFAULT NULL,
  `message_additionals` varchar(255) DEFAULT NULL,
  `log_type` varchar(6) DEFAULT NULL,
  `log_timestamp` timestamp NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
