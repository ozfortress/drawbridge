-- Awards Nomination & Voting System
-- Template categories hold the category definitions per template

CREATE TABLE `award_templates` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `description` text DEFAULT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `award_template_categories` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `template_id` int(11) NOT NULL,
  `name` varchar(100) NOT NULL,
  `fill_type` varchar(20) NOT NULL DEFAULT 'nomination',
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_aw_tmpl_cat_tmpl` (`template_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `award_events` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `league_id` int(11) NOT NULL,
  `template_id` int(11) DEFAULT NULL,
  `name` varchar(200) NOT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'pending',
  `nomination_deadline` datetime DEFAULT NULL,
  `voting_deadline` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_award_events_league` (`league_id`),
  KEY `idx_award_events_tmpl` (`template_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `award_event_categories` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `event_id` int(11) NOT NULL,
  `template_category_id` int(11) DEFAULT NULL,
  `name` varchar(100) NOT NULL,
  `fill_type` varchar(20) NOT NULL DEFAULT 'nomination',
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_award_cat_event` (`event_id`),
  KEY `idx_award_cat_tmpl_cat` (`template_category_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `award_admin_fill_options` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `event_id` int(11) NOT NULL,
  `category_id` int(11) NOT NULL,
  `option` varchar(200) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_aw_fill_cat` (`category_id`),
  KEY `idx_aw_fill_event` (`event_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `award_nominations` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `event_id` int(11) NOT NULL,
  `category_id` int(11) NOT NULL,
  `team_id` int(11) NOT NULL,
  `division_id` int(11) NOT NULL,
  `submitted_by` bigint(20) NOT NULL,
  `response` text NOT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'pending',
  `invalidated_by` bigint(20) DEFAULT NULL,
  `invalidated_at` datetime DEFAULT NULL,
  `invalidation_reason` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_award_nom_event` (`event_id`),
  KEY `idx_award_nom_cat` (`category_id`),
  KEY `idx_award_nom_team` (`team_id`),
  KEY `idx_award_nom_div` (`division_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `award_nomination_audit_log` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `nomination_id` int(11) NOT NULL,
  `action` varchar(50) NOT NULL,
  `admin_user_id` bigint(20) NOT NULL,
  `admin_username` varchar(100) DEFAULT NULL,
  `old_value` text DEFAULT NULL,
  `new_value` text DEFAULT NULL,
  `reason` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_award_nom_audit` (`nomination_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `award_votes` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `event_id` int(11) NOT NULL,
  `category_id` int(11) NOT NULL,
  `team_id` int(11) NOT NULL,
  `division_id` int(11) NOT NULL,
  `submitted_by` bigint(20) NOT NULL,
  `choice_1` text NOT NULL,
  `choice_2` text DEFAULT NULL,
  `choice_3` text DEFAULT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'pending',
  `invalidated_by` bigint(20) DEFAULT NULL,
  `invalidated_at` datetime DEFAULT NULL,
  `invalidation_reason` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_award_vote_event` (`event_id`),
  KEY `idx_award_vote_cat` (`category_id`),
  KEY `idx_award_vote_team` (`team_id`),
  KEY `idx_award_vote_div` (`division_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `award_vote_audit_log` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `vote_id` int(11) NOT NULL,
  `action` varchar(50) NOT NULL,
  `admin_user_id` bigint(20) NOT NULL,
  `admin_username` varchar(100) DEFAULT NULL,
  `old_value` text DEFAULT NULL,
  `new_value` text DEFAULT NULL,
  `reason` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_award_vote_audit` (`vote_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `award_results` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `event_id` int(11) NOT NULL,
  `category_id` int(11) NOT NULL,
  `division_id` int(11) NOT NULL,
  `placement` int(11) NOT NULL,
  `entry` varchar(200) NOT NULL,
  `points` int(11) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_award_result_event` (`event_id`),
  KEY `idx_award_result_cat` (`category_id`),
  KEY `idx_award_result_div` (`division_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
