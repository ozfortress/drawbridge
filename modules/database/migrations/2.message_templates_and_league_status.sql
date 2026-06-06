-- Add message templates table and league status

CREATE TABLE `message_templates` (
  `template_name` varchar(50) NOT NULL,
  `content` text NOT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`template_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Seed default templates from embed files
INSERT INTO `message_templates` (`template_name`, `content`) VALUES
('teams.json', '{\n  "content": "## {TEAM_MENTION} Support Channel",\n  "embeds": [{\n    "title": "> View your Team Page",\n    "description": "**Welcome to the {LEAGUE_NAME} ({LEAGUE_SHORTCODE}) Team Channel!**\\n\\nThis channel is **strictly for match communication**. Keep it clean, keep it fair. Here are a few reminders:\\n\\n1. **You MUST use this channel to communicate with the opposing team** — no more DMs, no more pings.\\n2. **Admins check this channel** regularly. If you see something, say something — ping an admin.\\n3. **Logs.tf links only** in here — no match hacks, no spoofs, no cap.\\n4. **DO NOT** @mention another team\'s channel unless you have their consent.\\n5. **All activity is logged** and reviewable by admins.\\n\\n> Use !log to submit match communications as\\n> Use !sub to request a substitute\\n> Use !ff to forfeit a match",\n    "url": "https://ozfortress.com/teams/{TEAM_ID}",\n    "color": 43962\n  }]\n}'),
('match.json', '{\n  "content": "## {ROUND_NAME}\\n{TEAM_HOME} (Home) vs. {TEAM_AWAY} (Away)",\n  "embeds": [{\n    "title": "> View your Match Thread",\n    "description": "**Welcome to the Match Channel!**\\n\\nHere are a few reminders for match communication:\\n\\n1. **Keep communications civil** — this channel is monitored by admins.\\n2. **Use logs.tf** to record your matches and submit results via the ozfortress website.\\n3. **Ping an admin** if there are any issues.\\n4. **All activity is logged** and reviewable by admins.",\n    "url": "https://ozfortress.com/matches/{MATCH_ID}",\n    "color": 43962\n  }]\n}'),
('democheck.json', '{\n  "content": "### {CHANNEL_ID} Demo Check",\n  "embeds": [{\n    "title": "> View the Round that Requires a Demo Check",\n    "description": "Our system has randomly selected a player to provide a POV demo of a recent match.\\n\\nHey {TARGET_NAME} (**{TEAM_NAME}**), you have been chosen at random to submit a POV demo for a recent match. Please upload your POV demo to [logs.tf](https://logs.tf/upload) and provide the link via the match channel for **Round {ROUND_NO}**.\\n\\nIf you have any questions or concerns, please contact an admin.",\n    "url": "https://ozfortress.com/matches/{MATCH_ID}",\n    "color": 43962\n  }]\n}');

-- Add status and updated_at to leagues
ALTER TABLE `leagues`
  ADD COLUMN `status` varchar(20) DEFAULT 'active',
  ADD COLUMN `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp();
