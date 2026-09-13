ALTER TABLE `tournament_schedule_settings`
  ADD COLUMN IF NOT EXISTS `role_overrides` longtext DEFAULT NULL COMMENT 'JSON list of {preset, role_ids} for tournament channel/role overrides';
