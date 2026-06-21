ALTER TABLE `match_schedules`
  ADD COLUMN `schedule_message_id` bigint(20) DEFAULT NULL COMMENT 'Discord message id of the scheduling prompt (set when scheduling is enabled, cleared when disabled)';
