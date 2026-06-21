"""
Database Repositories for Drawbridge
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Individual repository classes for each database table.

:copyright: (c) 2024-present ozfortress
"""

from typing import Dict, List, Optional, Any
from .base import BaseRepository


class LeaguesRepository(BaseRepository):
    """Repository for leagues table."""

    def __init__(self, db_connection):
        super().__init__(db_connection, 'leagues')

    def get_by_id(self, league_id: int) -> Optional[Dict[str, Any]]:
        """Get a league by its ID."""
        query = f"SELECT * FROM {self.table} WHERE league_id = ?"
        return self._fetch_one(query, (league_id,))

    def get_all(self) -> List[Dict[str, Any]]:
        """Get all leagues."""
        query = f"SELECT * FROM {self.table}"
        return self._fetch_all(query)

    def insert(self, league: Dict[str, Any]) -> Optional[int]:
        """Insert a new league."""
        if 'league_id' not in league:
            raise ValueError("Missing required field: league_id")
        if 'league_name' not in league:
            raise ValueError("Missing required field: league_name")

        query = f"""
            INSERT INTO {self.table} (league_id, league_name, league_shortcode)
            VALUES (?, ?, ?)
        """
        return self._execute_query(query, (
            league['league_id'], league['league_name'],
            league.get('league_shortcode', ''),
        ))

    def update(self, league_id: int, league: Dict[str, Any]) -> bool:
        """Update an existing league."""
        # Get existing record to merge with updates
        existing = self.get_by_id(league_id)
        if not existing:
            raise ValueError(f"League with ID {league_id} not found")

        # Merge updates with existing data
        updated_data = {**existing, **league}

        query = f"""
            UPDATE {self.table}
            SET league_name = ?, league_shortcode = ?
            WHERE league_id = ?
        """
        result = self._execute_query(query, (
            updated_data.get('league_name', ''),
            updated_data.get('league_shortcode', ''),
            league_id
        ))
        return result > 0

    def delete(self, league_id: int) -> bool:
        """Delete a league by its ID."""
        query = f"DELETE FROM {self.table} WHERE league_id = ?"
        result = self._execute_query(query, (league_id,))
        return result > 0


class DivisionsRepository(BaseRepository):
    """Repository for divisions table."""

    def __init__(self, db_connection):
        super().__init__(db_connection, 'divisions')

    def get_by_id(self, division_id: int) -> Optional[Dict[str, Any]]:
        """Get a division by its ID."""
        query = f"SELECT * FROM {self.table} WHERE id = ?"
        return self._fetch_one(query, (division_id,))

    def get_by_name(self, division_name: str) -> Optional[Dict[str, Any]]:
        """Get a division by its name."""
        query = f"SELECT * FROM {self.table} WHERE division_name = ?"
        return self._fetch_one(query, (division_name,))

    def get_by_league(self, league_id: int) -> List[Dict[str, Any]]:
        """Get all divisions in a league."""
        query = f"SELECT * FROM {self.table} WHERE league_id = ?"
        return self._fetch_all(query, (league_id,))

    def get_all(self) -> List[Dict[str, Any]]:
        """Get all divisions."""
        query = f"SELECT * FROM {self.table}"
        return self._fetch_all(query)

    def insert(self, division: Dict[str, Any]) -> Optional[int]:
        """Insert a new division."""
        required_fields = ['league_id', 'division_name', 'role_id', 'category_id']

        if not all(field in division for field in required_fields):
            raise ValueError(f"Missing required fields: {required_fields}")

        query = f"""
            INSERT INTO {self.table} (league_id, division_name, role_id, category_id)
            VALUES (?, ?, ?, ?)
        """
        return self._execute_query(query, (
            division['league_id'], division['division_name'],
            division['role_id'], division['category_id']
        ))

    def update(self, division_id: int, division: Dict[str, Any]) -> bool:
        """Update an existing division."""
        existing = self.get_by_id(division_id)
        if not existing:
            raise ValueError(f"Division with ID {division_id} not found")

        updated_data = {**existing, **division}

        query = f"""
            UPDATE {self.table}
            SET league_id = ?, division_name = ?, role_id = ?, category_id = ?
            WHERE id = ?
        """
        result = self._execute_query(query, (
            updated_data['league_id'], updated_data['division_name'],
            updated_data['role_id'], updated_data['category_id'],
            division_id
        ))
        return result > 0

    def delete(self, division_id: int) -> bool:
        """Delete a division by its ID."""
        query = f"DELETE FROM {self.table} WHERE id = ?"
        result = self._execute_query(query, (division_id,))
        return result > 0

    def delete_by_league(self, league_id: int) -> bool:
        """Delete all divisions in a league."""
        query = f"DELETE FROM {self.table} WHERE league_id = ?"
        result = self._execute_query(query, (league_id,))
        return result > 0

    def count_by_league(self, league_id: int) -> int:
        """Get the number of divisions in a league."""
        query = f"SELECT COUNT(*) FROM {self.table} WHERE league_id = ?"
        return self._fetch_scalar(query, (league_id,)) or 0


class TeamsRepository(BaseRepository):
    """Repository for teams table."""

    def __init__(self, db_connection):
        super().__init__(db_connection, 'teams')

    def get_by_id(self, roster_id: int) -> Optional[Dict[str, Any]]:
        """Get a team by its roster ID."""
        query = f"SELECT * FROM {self.table} WHERE roster_id = ?"
        return self._fetch_one(query, (roster_id,))

    def get_by_team_id(self, team_id: int) -> Optional[Dict[str, Any]]:
        """Get a team by its team ID."""
        query = f"SELECT * FROM {self.table} WHERE team_id = ?"
        return self._fetch_one(query, (team_id,))

    def get_by_team_and_league(self, team_id: int, league_id: int) -> Optional[Dict[str, Any]]:
        """Get a team by team ID and league ID (handles multi-league teams)."""
        query = f"SELECT * FROM {self.table} WHERE team_id = ? AND league_id = ?"
        return self._fetch_one(query, (team_id, league_id))

    def get_by_channel_id(self, channel_id: int) -> Optional[Dict[str, Any]]:
        """Get a team by its Discord channel ID."""
        query = f"SELECT * FROM {self.table} WHERE team_channel = ?"
        return self._fetch_one(query, (channel_id,))

    def get_by_role_id(self, role_id: int) -> Optional[Dict[str, Any]]:
        """Get a team by its Discord role ID."""
        query = f"SELECT * FROM {self.table} WHERE role_id = ?"
        return self._fetch_one(query, (role_id,))

    def get_by_league(self, league_id: int) -> List[Dict[str, Any]]:
        """Get all teams in a league."""
        query = f"SELECT * FROM {self.table} WHERE league_id = ?"
        return self._fetch_all(query, (league_id,))

    def get_by_division(self, division_id: int) -> List[Dict[str, Any]]:
        """Get all teams in a division."""
        query = f"SELECT * FROM {self.table} WHERE division = ?"
        return self._fetch_all(query, (division_id,))

    def get_all(self) -> List[Dict[str, Any]]:
        """Get all teams."""
        query = f"SELECT * FROM {self.table}"
        return self._fetch_all(query)

    def insert(self, team: Dict[str, Any]) -> Optional[int]:
        """Insert a new team."""
        required_fields = ['roster_id', 'team_id', 'league_id', 'role_id', 'team_channel', 'division', 'team_name']

        if not all(field in team for field in required_fields):
            raise ValueError(f"Missing required fields: {required_fields}")

        query = f"""
            INSERT INTO {self.table} (roster_id, team_id, league_id, role_id, team_channel, division, team_name)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """
        return self._execute_query(query, (
            team['roster_id'], team['team_id'], team['league_id'],
            team['role_id'], team['team_channel'], team['division'], team['team_name']
        ))

    def update(self, roster_id: int, team: Dict[str, Any]) -> bool:
        """Update an existing team."""
        existing = self.get_by_id(roster_id)
        if not existing:
            raise ValueError(f"Team with roster ID {roster_id} not found")

        updated_data = {**existing, **team}

        query = f"""
            UPDATE {self.table}
            SET team_id = ?, league_id = ?, role_id = ?, team_channel = ?, division = ?, team_name = ?
            WHERE roster_id = ?
        """
        result = self._execute_query(query, (
            updated_data['team_id'], updated_data['league_id'],
            updated_data['role_id'], updated_data['team_channel'],
            updated_data['division'], updated_data['team_name'],
            roster_id
        ))
        return result > 0

    def delete(self, roster_id: int) -> bool:
        """Delete a team by its roster ID."""
        query = f"DELETE FROM {self.table} WHERE roster_id = ?"
        result = self._execute_query(query, (roster_id,))
        return result > 0

    def delete_by_league(self, league_id: int) -> bool:
        """Delete all teams in a league."""
        query = f"DELETE FROM {self.table} WHERE league_id = ?"
        result = self._execute_query(query, (league_id,))
        return result > 0

    def count_by_league(self, league_id: int) -> int:
        """Get the number of teams in a league."""
        query = f"SELECT COUNT(*) FROM {self.table} WHERE league_id = ?"
        return self._fetch_scalar(query, (league_id,)) or 0

    def count_by_division(self, division_id: int) -> int:
        """Get the number of teams in a division."""
        query = f"SELECT COUNT(*) FROM {self.table} WHERE division = ?"
        return self._fetch_scalar(query, (division_id,)) or 0


class MatchesRepository(BaseRepository):
    """Repository for matches table."""

    def __init__(self, db_connection):
        super().__init__(db_connection, 'matches')

    def get_by_id(self, match_id: int) -> Optional[Dict[str, Any]]:
        """Get a match by its ID."""
        query = f"SELECT * FROM {self.table} WHERE match_id = ?"
        return self._fetch_one(query, (match_id,))

    def get_by_channel_id(self, channel_id: int) -> Optional[Dict[str, Any]]:
        """Get a match by its Discord channel ID."""
        query = f"SELECT * FROM {self.table} WHERE channel_id = ?"
        return self._fetch_one(query, (channel_id,))

    def get_by_league(self, league_id: int) -> List[Dict[str, Any]]:
        """Get all matches in a league."""
        query = f"SELECT * FROM {self.table} WHERE league_id = ?"
        return self._fetch_all(query, (league_id,))

    def get_by_division(self, division_id: int) -> List[Dict[str, Any]]:
        """Get all matches in a division."""
        query = f"SELECT * FROM {self.table} WHERE division = ?"
        return self._fetch_all(query, (division_id,))

    def get_unarchived(self) -> List[Dict[str, Any]]:
        """Get all unarchived matches."""
        query = f"SELECT * FROM {self.table} WHERE archived = 0"
        return self._fetch_all(query)

    def get_all(self) -> List[Dict[str, Any]]:
        """Get all matches."""
        query = f"SELECT * FROM {self.table}"
        return self._fetch_all(query)

    def insert(self, match: Dict[str, Any]) -> int:
        """Insert a new match."""
        required_fields = ['match_id', 'division', 'team_home', 'team_away', 'channel_id', 'league_id']

        if not all(field in match for field in required_fields):
            raise ValueError(f"Missing required fields: {required_fields}")

        query = f"""
            INSERT INTO {self.table} (match_id, division, team_home, team_away, channel_id, archived, league_id)
            VALUES (?, ?, ?, ?, ?, 0, ?)
        """
        return self._execute_query(query, (
            match['match_id'], match['division'], match['team_home'],
            match['team_away'], match['channel_id'], match['league_id']
        ))

    def update(self, match_id: int, match: Dict[str, Any]) -> bool:
        """Update an existing match."""
        existing = self.get_by_id(match_id)
        if not existing:
            raise ValueError(f"Match with ID {match_id} not found")

        updated_data = {**existing, **match}

        query = f"""
            UPDATE {self.table}
            SET division = ?, team_home = ?, team_away = ?, channel_id = ?, archived = ?, league_id = ?
            WHERE match_id = ?
        """
        result = self._execute_query(query, (
            updated_data['division'], updated_data['team_home'],
            updated_data['team_away'], updated_data['channel_id'],
            updated_data['archived'], updated_data['league_id'],
            match_id
        ))
        return result > 0

    def archive(self, match_id: int) -> bool:
        """Archive a match."""
        return self.update(match_id, {'archived': 1})

    def delete(self, match_id: int) -> bool:
        """Delete a match by its ID."""
        query = f"DELETE FROM {self.table} WHERE match_id = ?"
        result = self._execute_query(query, (match_id,))
        return result > 0

    def delete_by_league(self, league_id: int) -> bool:
        """Delete all matches in a league."""
        query = f"DELETE FROM {self.table} WHERE league_id = ?"
        result = self._execute_query(query, (league_id,))
        return result > 0

    def count_by_league(self, league_id: int) -> int:
        """Get the number of matches in a league."""
        query = f"SELECT COUNT(*) FROM {self.table} WHERE league_id = ?"
        return self._fetch_scalar(query, (league_id,)) or 0

    def count_by_division(self, division_id: int) -> int:
        """Get the number of matches in a division."""
        query = f"SELECT COUNT(*) FROM {self.table} WHERE division = ?"
        return self._fetch_scalar(query, (division_id,)) or 0


class LogsRepository(BaseRepository):
    """Repository for logs table."""

    def __init__(self, db_connection):
        super().__init__(db_connection, 'logs')

    def get_by_id(self, log_id: int) -> Optional[Dict[str, Any]]:
        """Get a log by its ID."""
        query = f"SELECT * FROM {self.table} WHERE id = ?"
        return self._fetch_one(query, (log_id,))

    def get_by_match_id(self, match_id: int) -> List[Dict[str, Any]]:
        """Get all logs for a match."""
        query = f"SELECT * FROM {self.table} WHERE match_id = ?"
        return self._fetch_all(query, (match_id,))

    def get_by_team_id(self, team_id: int) -> List[Dict[str, Any]]:
        """Get all logs for a team."""
        query = f"SELECT * FROM {self.table} WHERE team_id = ?"
        return self._fetch_all(query, (team_id,))

    def get_all(self) -> List[Dict[str, Any]]:
        """Get all logs."""
        query = f"SELECT * FROM {self.table}"
        return self._fetch_all(query)

    def insert(self, log: Dict[str, Any]) -> Optional[int]:
        """Insert a new log entry."""
        required_fields = [
            'match_id', 'user_id', 'user_name', 'user_nick', 'user_avatar',
            'team_id', 'message_id', 'message_content', 'message_additionals',
            'log_type', 'log_timestamp'
        ]

        if not all(field in log for field in required_fields):
            raise ValueError(f"Missing required fields: {required_fields}")

        query = f"""
            INSERT INTO {self.table}
            (match_id, user_id, user_name, user_nick, user_avatar, team_id,
             message_id, message_content, message_additionals, log_type, log_timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """
        return self._execute_query(query, (
            log['match_id'], log['user_id'], log['user_name'], log['user_nick'],
            log['user_avatar'], log['team_id'], log['message_id'],
            log['message_content'], log['message_additionals'],
            log['log_type'], log['log_timestamp']
        ))

    def update(self, log_id: int, log: Dict[str, Any]) -> bool:
        """Update is not implemented for logs - they are immutable by design."""
        raise NotImplementedError('Update not implemented for logs - logs are designed to be immutable')

    def delete(self, log_id: int) -> bool:
        """Delete is not implemented for logs - they are kept indefinitely."""
        raise NotImplementedError('Delete not implemented for logs - logs are designed to be kept indefinitely')

    def count_by_match_id(self, match_id: int) -> int:
        """Get the number of logs for a match."""
        query = f"SELECT COUNT(*) FROM {self.table} WHERE match_id = ?"
        return self._fetch_scalar(query, (match_id,)) or 0

    def count_by_team_id(self, team_id: int) -> int:
        """Get the number of logs for a team."""
        query = f"SELECT COUNT(*) FROM {self.table} WHERE team_id = ?"
        return self._fetch_scalar(query, (team_id,)) or 0


class SyncedUsersRepository(BaseRepository):
    """Repository for synced users table."""

    def __init__(self, db_connection):
        super().__init__(db_connection, 'synced_users')

    def get_by_id(self, discord_id: int) -> Optional[Dict[str, Any]]:
        """Get a user by Discord ID."""
        query = f"SELECT * FROM {self.table} WHERE discord_id = ?"
        return self._fetch_one(query, (discord_id,))

    def get_by_citadel_id(self, citadel_id: int) -> Optional[Dict[str, Any]]:
        """Get a user by Citadel ID."""
        query = f"SELECT * FROM {self.table} WHERE citadel_id = ?"
        return self._fetch_one(query, (citadel_id,))

    def get_all(self) -> List[Dict[str, Any]]:
        """Get all synced users."""
        query = f"SELECT * FROM {self.table}"
        return self._fetch_all(query)

    def has_synced_citadel(self, citadel_id: int) -> bool:
        """Check if a Citadel user has synced."""
        count = self._fetch_scalar(f"SELECT COUNT(*) FROM {self.table} WHERE citadel_id = ?", (citadel_id,))
        return (count or 0) > 0

    def has_synced_discord(self, discord_id: int) -> bool:
        """Check if a Discord user has synced."""
        count = self._fetch_scalar(f"SELECT COUNT(*) FROM {self.table} WHERE discord_id = ?", (discord_id,))
        return (count or 0) > 0

    def insert(self, user: Dict[str, Any]) -> Optional[int]:
        """Insert a new synced user."""
        required_fields = ['citadel_id', 'discord_id', 'steam_id']

        if not all(field in user for field in required_fields):
            raise ValueError(f"Missing required fields: {required_fields}")

        query = f"""
            INSERT INTO {self.table} (citadel_id, discord_id, steam_id, time_created, time_modified)
            VALUES (?, ?, ?, NOW(), NOW())
        """
        return self._execute_query(query, (
            user['citadel_id'], user['discord_id'], user['steam_id']
        ))

    def update(self, discord_id: int, user: Dict[str, Any]) -> bool:
        """Update an existing synced user."""
        existing = self.get_by_id(discord_id)
        if not existing:
            raise ValueError(f"User with Discord ID {discord_id} not found")

        updated_data = {**existing, **user}

        query = f"""
            UPDATE {self.table}
            SET citadel_id = ?, steam_id = ?, time_modified = NOW()
            WHERE discord_id = ?
        """
        result = self._execute_query(query, (
            updated_data['citadel_id'], updated_data['steam_id'], discord_id
        ))
        return result > 0

    def delete(self, discord_id: int) -> bool:
        """Delete a synced user by Discord ID."""
        query = f"DELETE FROM {self.table} WHERE discord_id = ?"
        result = self._execute_query(query, (discord_id,))
        return result > 0


class MessageTemplatesRepository(BaseRepository):
    """Repository for message_templates table."""

    def __init__(self, db_connection):
        super().__init__(db_connection, 'message_templates')

    def get_by_id(self, template_name: str) -> Optional[Dict[str, Any]]:
        """Get a template by its name (primary key)."""
        query = f"SELECT * FROM {self.table} WHERE template_name = ?"
        return self._fetch_one(query, (template_name,))

    def get_by_name(self, template_name: str) -> Optional[Dict[str, Any]]:
        """Alias for get_by_id."""
        return self.get_by_id(template_name)

    def get_all(self) -> List[Dict[str, Any]]:
        """Get all templates."""
        query = f"SELECT * FROM {self.table}"
        return self._fetch_all(query)

    def insert(self, data: Dict[str, Any]) -> Optional[int]:
        """Insert a new template."""
        query = f"""
            INSERT INTO {self.table} (template_name, content, updated_at)
            VALUES (?, ?, NOW())
        """
        return self._execute_query(query, (data['template_name'], data['content']))

    def update(self, template_name: str, data: Dict[str, Any]) -> bool:
        """Update an existing template."""
        query = f"""
            UPDATE {self.table}
            SET content = ?, updated_at = NOW()
            WHERE template_name = ?
        """
        result = self._execute_query(query, (data['content'], template_name))
        return result > 0

    def delete(self, template_name: str) -> bool:
        """Delete a template by its name."""
        query = f"DELETE FROM {self.table} WHERE template_name = ?"
        result = self._execute_query(query, (template_name,))
        return result > 0

    def upsert(self, template_name: str, content: str) -> bool:
        """Insert or update a template."""
        existing = self.get_by_id(template_name)
        if existing:
            return self.update(template_name, {'content': content})
        return bool(self.insert({'template_name': template_name, 'content': content}))


class AwardTemplatesRepository(BaseRepository):
    """Repository for award_templates table."""

    def __init__(self, db_connection):
        super().__init__(db_connection, 'award_templates')

    def get_by_id(self, tmpl_id: int) -> Optional[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE id = ?"
        return self._fetch_one(query, (tmpl_id,))

    def get_all(self) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} ORDER BY sort_order, id"
        return self._fetch_all(query)

    def insert(self, data: Dict[str, Any]) -> Optional[int]:
        if 'name' not in data:
            raise ValueError("Missing required field: name")
        query = f"""
            INSERT INTO {self.table} (name, description, sort_order)
            VALUES (?, ?, ?)
        """
        return self._execute_query(query, (
            data['name'], data.get('description', ''), data.get('sort_order', 0)
        ))

    def update(self, tmpl_id: int, data: Dict[str, Any]) -> bool:
        existing = self.get_by_id(tmpl_id)
        if not existing:
            raise ValueError(f"AwardTemplate with ID {tmpl_id} not found")
        merged = {**existing, **data}
        query = f"""
            UPDATE {self.table}
            SET name = ?, description = ?, sort_order = ?
            WHERE id = ?
        """
        result = self._execute_query(query, (
            merged['name'], merged.get('description', ''), merged.get('sort_order', 0), tmpl_id
        ))
        return result > 0

    def delete(self, tmpl_id: int) -> bool:
        query = f"DELETE FROM {self.table} WHERE id = ?"
        result = self._execute_query(query, (tmpl_id,))
        return result > 0

    def reorder(self, ordered_ids: List[int]) -> bool:
        for i, tid in enumerate(ordered_ids):
            self._execute_query(f"UPDATE {self.table} SET sort_order = ? WHERE id = ?", (i, tid))
        return True


class AwardTemplateCategoriesRepository(BaseRepository):
    """Repository for award_template_categories table."""

    def __init__(self, db_connection):
        super().__init__(db_connection, 'award_template_categories')

    def get_by_id(self, cat_id: int) -> Optional[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE id = ?"
        return self._fetch_one(query, (cat_id,))

    def get_by_template(self, template_id: int) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE template_id = ? ORDER BY sort_order, id"
        return self._fetch_all(query, (template_id,))

    def get_all(self) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} ORDER BY template_id, sort_order"
        return self._fetch_all(query)

    def insert(self, data: Dict[str, Any]) -> Optional[int]:
        required = ['template_id', 'name']
        for f in required:
            if f not in data:
                raise ValueError(f"Missing required field: {f}")
        query = f"""
            INSERT INTO {self.table} (template_id, name, fill_type, sort_order)
            VALUES (?, ?, ?, ?)
        """
        return self._execute_query(query, (
            data['template_id'], data['name'],
            data.get('fill_type', 'nomination'), data.get('sort_order', 0)
        ))

    def update(self, cat_id: int, data: Dict[str, Any]) -> bool:
        existing = self.get_by_id(cat_id)
        if not existing:
            raise ValueError(f"TemplateCategory with ID {cat_id} not found")
        merged = {**existing, **data}
        query = f"""
            UPDATE {self.table}
            SET name = ?, fill_type = ?, sort_order = ?
            WHERE id = ?
        """
        result = self._execute_query(query, (
            merged['name'], merged['fill_type'], merged.get('sort_order', 0), cat_id
        ))
        return result > 0

    def delete(self, cat_id: int) -> bool:
        query = f"DELETE FROM {self.table} WHERE id = ?"
        result = self._execute_query(query, (cat_id,))
        return result > 0

    def delete_by_template(self, template_id: int) -> bool:
        return self._execute_query(f"DELETE FROM {self.table} WHERE template_id = ?", (template_id,)) > 0


class AwardEventsRepository(BaseRepository):
    """Repository for award_events table."""

    def __init__(self, db_connection):
        super().__init__(db_connection, 'award_events')

    def get_by_id(self, event_id: int) -> Optional[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE id = ?"
        return self._fetch_one(query, (event_id,))

    def get_all(self) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} ORDER BY created_at DESC"
        return self._fetch_all(query)

    def get_by_league(self, league_id: int) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE league_id = ? ORDER BY created_at DESC"
        return self._fetch_all(query, (league_id,))

    def insert(self, data: Dict[str, Any]) -> Optional[int]:
        required = ['league_id', 'name']
        for f in required:
            if f not in data:
                raise ValueError(f"Missing required field: {f}")
        query = f"""
            INSERT INTO {self.table} (league_id, template_id, name, status, nomination_deadline, voting_deadline)
            VALUES (?, ?, ?, ?, ?, ?)
        """
        return self._execute_query(query, (
            data['league_id'], data.get('template_id'), data['name'],
            data.get('status', 'pending'),
            data.get('nomination_deadline'),
            data.get('voting_deadline'),
        ))

    def update(self, event_id: int, data: Dict[str, Any]) -> bool:
        existing = self.get_by_id(event_id)
        if not existing:
            raise ValueError(f"AwardEvent with ID {event_id} not found")
        merged = {**existing, **data}
        query = f"""
            UPDATE {self.table}
            SET league_id = ?, template_id = ?, name = ?, status = ?, nomination_deadline = ?, voting_deadline = ?
            WHERE id = ?
        """
        result = self._execute_query(query, (
            merged['league_id'], merged.get('template_id'), merged['name'], merged['status'],
            merged.get('nomination_deadline'), merged.get('voting_deadline'),
            event_id
        ))
        return result > 0

    def delete(self, event_id: int) -> bool:
        query = f"DELETE FROM {self.table} WHERE id = ?"
        result = self._execute_query(query, (event_id,))
        return result > 0

    def set_status(self, event_id: int, status: str) -> bool:
        query = f"UPDATE {self.table} SET status = ? WHERE id = ?"
        return self._execute_query(query, (status, event_id)) > 0


class AwardEventCategoriesRepository(BaseRepository):
    """Repository for award_event_categories table."""

    def __init__(self, db_connection):
        super().__init__(db_connection, 'award_event_categories')

    def get_by_id(self, cat_id: int) -> Optional[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE id = ?"
        return self._fetch_one(query, (cat_id,))

    def get_all(self) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} ORDER BY sort_order, id"
        return self._fetch_all(query)

    def get_by_event(self, event_id: int) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE event_id = ? ORDER BY sort_order, id"
        return self._fetch_all(query, (event_id,))

    def get_by_event_and_fill_types(self, event_id: int, fill_types: List[str]) -> List[Dict[str, Any]]:
        placeholders = ','.join('?' * len(fill_types))
        query = f"SELECT * FROM {self.table} WHERE event_id = ? AND fill_type IN ({placeholders}) ORDER BY sort_order, id"
        return self._fetch_all(query, (event_id, *fill_types))

    def insert(self, data: Dict[str, Any]) -> Optional[int]:
        for f in ['event_id', 'name']:
            if f not in data:
                raise ValueError(f"Missing required field: {f}")
        query = f"""
            INSERT INTO {self.table} (event_id, template_category_id, name, fill_type, sort_order)
            VALUES (?, ?, ?, ?, ?)
        """
        return self._execute_query(query, (
            data['event_id'], data.get('template_category_id'),
            data['name'], data.get('fill_type', 'nomination'), data.get('sort_order', 0)
        ))

    def update(self, cat_id: int, data: Dict[str, Any]) -> bool:
        existing = self.get_by_id(cat_id)
        if not existing:
            raise ValueError(f"Category with ID {cat_id} not found")
        merged = {**existing, **data}
        query = f"""
            UPDATE {self.table}
            SET template_category_id = ?, name = ?, fill_type = ?, sort_order = ?
            WHERE id = ?
        """
        result = self._execute_query(query, (
            merged.get('template_category_id'), merged['name'],
            merged['fill_type'], merged.get('sort_order', 0), cat_id
        ))
        return result > 0

    def delete(self, cat_id: int) -> bool:
        query = f"DELETE FROM {self.table} WHERE id = ?"
        result = self._execute_query(query, (cat_id,))
        return result > 0


class AwardNominationsRepository(BaseRepository):
    """Repository for award_nominations table."""

    def __init__(self, db_connection):
        super().__init__(db_connection, 'award_nominations')

    def get_by_id(self, nom_id: int) -> Optional[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE id = ?"
        return self._fetch_one(query, (nom_id,))

    def get_all(self) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table}"
        return self._fetch_all(query)

    def get_by_event(self, event_id: int) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE event_id = ? ORDER BY division_id, team_id, category_id"
        return self._fetch_all(query, (event_id,))

    def get_by_event_and_category(self, event_id: int, category_id: int) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE event_id = ? AND category_id = ?"
        return self._fetch_all(query, (event_id, category_id))

    def get_by_team_and_category(self, team_id: int, category_id: int) -> Optional[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE team_id = ? AND category_id = ?"
        return self._fetch_one(query, (team_id, category_id))

    def get_by_team_and_event(self, team_id: int, event_id: int) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE team_id = ? AND event_id = ?"
        return self._fetch_all(query, (team_id, event_id))

    def get_by_division(self, division_id: int, event_id: int) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE division_id = ? AND event_id = ?"
        return self._fetch_all(query, (division_id, event_id))

    def insert(self, data: Dict[str, Any]) -> Optional[int]:
        required = ['event_id', 'category_id', 'team_id', 'division_id', 'submitted_by', 'response']
        for f in required:
            if f not in data:
                raise ValueError(f"Missing required field: {f}")
        query = f"""
            INSERT INTO {self.table}
            (event_id, category_id, team_id, division_id, submitted_by, response, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """
        return self._execute_query(query, (
            data['event_id'], data['category_id'], data['team_id'],
            data['division_id'], data['submitted_by'], data['response'],
            data.get('status', 'accepted')
        ))

    def update(self, nom_id: int, data: Dict[str, Any]) -> bool:
        existing = self.get_by_id(nom_id)
        if not existing:
            raise ValueError(f"Nomination with ID {nom_id} not found")
        merged = {**existing, **data}
        query = f"""
            UPDATE {self.table}
            SET response = ?, status = ?, invalidated_by = ?, invalidated_at = ?,
                invalidation_reason = ?
            WHERE id = ?
        """
        result = self._execute_query(query, (
            merged['response'], merged['status'],
            merged.get('invalidated_by'), merged.get('invalidated_at'),
            merged.get('invalidation_reason'), nom_id
        ))
        return result > 0

    def delete(self, nom_id: int) -> bool:
        query = f"DELETE FROM {self.table} WHERE id = ?"
        result = self._execute_query(query, (nom_id,))
        return result > 0

    def set_status(self, nom_id: int, status: str, invalidated_by: int = None, reason: str = None) -> bool:
        query = f"""
            UPDATE {self.table}
            SET status = ?, invalidated_by = ?,
                invalidated_at = CASE WHEN ? IS NOT NULL THEN NOW() ELSE NULL END,
                invalidation_reason = ?
            WHERE id = ?
        """
        return self._execute_query(query, (status, invalidated_by, invalidated_by, reason, nom_id)) > 0

    def count_by_event(self, event_id: int) -> int:
        return self._fetch_scalar(f"SELECT COUNT(*) FROM {self.table} WHERE event_id = ?", (event_id,)) or 0

    def count_by_team(self, team_id: int, event_id: int) -> int:
        return self._fetch_scalar(f"SELECT COUNT(*) FROM {self.table} WHERE team_id = ? AND event_id = ?", (team_id, event_id)) or 0

    def distinct_responses(self, event_id: int, category_id: int) -> List[str]:
        rows = self._fetch_all(
            f"SELECT DISTINCT response FROM {self.table} WHERE event_id = ? AND category_id = ? AND status = 'accepted'",
            (event_id, category_id)
        )
        return [r['response'] for r in rows if r.get('response')]

    def has_team_submitted_all(self, team_id: int, event_id: int, category_ids: List[int]) -> bool:
        if not category_ids:
            return False
        count = self._fetch_scalar(
            f"SELECT COUNT(*) FROM {self.table} WHERE team_id = ? AND event_id = ? AND category_id IN ({','.join('?' * len(category_ids))})",
            (team_id, event_id, *category_ids)
        ) or 0
        return count == len(category_ids)

    def delete_by_event(self, event_id: int) -> bool:
        return self._execute_query(f"DELETE FROM {self.table} WHERE event_id = ?", (event_id,)) > 0

    def delete_by_category(self, category_id: int) -> bool:
        return self._execute_query(f"DELETE FROM {self.table} WHERE category_id = ?", (category_id,)) > 0


class AwardNominationAuditLogRepository(BaseRepository):
    """Repository for award_nomination_audit_log table."""

    def __init__(self, db_connection):
        super().__init__(db_connection, 'award_nomination_audit_log')

    def get_by_id(self, log_id: int) -> Optional[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE id = ?"
        return self._fetch_one(query, (log_id,))

    def get_all(self) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} ORDER BY created_at DESC"
        return self._fetch_all(query)

    def get_by_nomination(self, nomination_id: int) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE nomination_id = ? ORDER BY created_at DESC"
        return self._fetch_all(query, (nomination_id,))

    def insert(self, data: Dict[str, Any]) -> Optional[int]:
        required = ['nomination_id', 'action', 'admin_user_id']
        for f in required:
            if f not in data:
                raise ValueError(f"Missing required field: {f}")
        query = f"""
            INSERT INTO {self.table}
            (nomination_id, action, admin_user_id, admin_username, old_value, new_value, reason)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """
        return self._execute_query(query, (
            data['nomination_id'], data['action'], data['admin_user_id'],
            data.get('admin_username'), data.get('old_value'),
            data.get('new_value'), data.get('reason')
        ))

    def update(self, log_id: int, data: Dict[str, Any]) -> bool:
        raise NotImplementedError('Audit log entries are immutable')

    def delete(self, log_id: int) -> bool:
        raise NotImplementedError('Audit log entries are immutable')


class AwardVotesRepository(BaseRepository):
    """Repository for award_votes table."""

    def __init__(self, db_connection):
        super().__init__(db_connection, 'award_votes')

    def get_by_id(self, vote_id: int) -> Optional[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE id = ?"
        return self._fetch_one(query, (vote_id,))

    def get_all(self) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table}"
        return self._fetch_all(query)

    def get_by_event(self, event_id: int) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE event_id = ? ORDER BY division_id, team_id, category_id"
        return self._fetch_all(query, (event_id,))

    def get_by_event_and_category(self, event_id: int, category_id: int) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE event_id = ? AND category_id = ?"
        return self._fetch_all(query, (event_id, category_id))

    def get_by_team_and_event(self, team_id: int, event_id: int) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE team_id = ? AND event_id = ?"
        return self._fetch_all(query, (team_id, event_id))

    def get_by_team_and_category(self, team_id: int, category_id: int) -> Optional[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE team_id = ? AND category_id = ?"
        return self._fetch_one(query, (team_id, category_id))

    def get_by_division(self, division_id: int, event_id: int) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE division_id = ? AND event_id = ?"
        return self._fetch_all(query, (division_id, event_id))

    def insert(self, data: Dict[str, Any]) -> Optional[int]:
        required = ['event_id', 'category_id', 'team_id', 'division_id', 'submitted_by', 'choice_1']
        for f in required:
            if f not in data:
                raise ValueError(f"Missing required field: {f}")
        query = f"""
            INSERT INTO {self.table}
            (event_id, category_id, team_id, division_id, submitted_by, choice_1, choice_2, choice_3, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """
        return self._execute_query(query, (
            data['event_id'], data['category_id'], data['team_id'],
            data['division_id'], data['submitted_by'], data['choice_1'],
            data.get('choice_2'), data.get('choice_3'),
            data.get('status', 'accepted')
        ))

    def update(self, vote_id: int, data: Dict[str, Any]) -> bool:
        existing = self.get_by_id(vote_id)
        if not existing:
            raise ValueError(f"Vote with ID {vote_id} not found")
        merged = {**existing, **data}
        query = f"""
            UPDATE {self.table}
            SET choice_1 = ?, choice_2 = ?, choice_3 = ?, status = ?,
                invalidated_by = ?, invalidated_at = ?, invalidation_reason = ?
            WHERE id = ?
        """
        result = self._execute_query(query, (
            merged['choice_1'], merged.get('choice_2'), merged.get('choice_3'),
            merged['status'], merged.get('invalidated_by'),
            merged.get('invalidated_at'), merged.get('invalidation_reason'),
            vote_id
        ))
        return result > 0

    def delete(self, vote_id: int) -> bool:
        query = f"DELETE FROM {self.table} WHERE id = ?"
        result = self._execute_query(query, (vote_id,))
        return result > 0

    def set_status(self, vote_id: int, status: str, invalidated_by: int = None, reason: str = None) -> bool:
        query = f"""
            UPDATE {self.table}
            SET status = ?, invalidated_by = ?,
                invalidated_at = CASE WHEN ? IS NOT NULL THEN NOW() ELSE NULL END,
                invalidation_reason = ?
            WHERE id = ?
        """
        return self._execute_query(query, (status, invalidated_by, invalidated_by, reason, vote_id)) > 0

    def count_by_event(self, event_id: int) -> int:
        return self._fetch_scalar(f"SELECT COUNT(*) FROM {self.table} WHERE event_id = ?", (event_id,)) or 0

    def count_by_team(self, team_id: int, event_id: int) -> int:
        return self._fetch_scalar(f"SELECT COUNT(*) FROM {self.table} WHERE team_id = ? AND event_id = ?", (team_id, event_id)) or 0

    def has_team_submitted_all(self, team_id: int, event_id: int, category_ids: List[int]) -> bool:
        if not category_ids:
            return False
        count = self._fetch_scalar(
            f"SELECT COUNT(*) FROM {self.table} WHERE team_id = ? AND event_id = ? AND category_id IN ({','.join('?' * len(category_ids))})",
            (team_id, event_id, *category_ids)
        ) or 0
        return count == len(category_ids)

    def delete_by_event(self, event_id: int) -> bool:
        return self._execute_query(f"DELETE FROM {self.table} WHERE event_id = ?", (event_id,)) > 0

    def delete_by_category(self, category_id: int) -> bool:
        return self._execute_query(f"DELETE FROM {self.table} WHERE category_id = ?", (category_id,)) > 0


class AwardVoteAuditLogRepository(BaseRepository):
    """Repository for award_vote_audit_log table."""

    def __init__(self, db_connection):
        super().__init__(db_connection, 'award_vote_audit_log')

    def get_by_id(self, log_id: int) -> Optional[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE id = ?"
        return self._fetch_one(query, (log_id,))

    def get_all(self) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} ORDER BY created_at DESC"
        return self._fetch_all(query)

    def get_by_vote(self, vote_id: int) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE vote_id = ? ORDER BY created_at DESC"
        return self._fetch_all(query, (vote_id,))

    def insert(self, data: Dict[str, Any]) -> Optional[int]:
        required = ['vote_id', 'action', 'admin_user_id']
        for f in required:
            if f not in data:
                raise ValueError(f"Missing required field: {f}")
        query = f"""
            INSERT INTO {self.table}
            (vote_id, action, admin_user_id, admin_username, old_value, new_value, reason)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """
        return self._execute_query(query, (
            data['vote_id'], data['action'], data['admin_user_id'],
            data.get('admin_username'), data.get('old_value'),
            data.get('new_value'), data.get('reason')
        ))

    def update(self, log_id: int, data: Dict[str, Any]) -> bool:
        raise NotImplementedError('Audit log entries are immutable')

    def delete(self, log_id: int) -> bool:
        raise NotImplementedError('Audit log entries are immutable')


class AwardResultsRepository(BaseRepository):
    """Repository for award_results table."""

    def __init__(self, db_connection):
        super().__init__(db_connection, 'award_results')

    def get_by_id(self, result_id: int) -> Optional[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE id = ?"
        return self._fetch_one(query, (result_id,))

    def get_all(self) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table}"
        return self._fetch_all(query)

    def get_by_event(self, event_id: int) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE event_id = ? ORDER BY division_id, category_id, placement"
        return self._fetch_all(query, (event_id,))

    def get_by_event_and_division(self, event_id: int, division_id: int) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE event_id = ? AND division_id = ? ORDER BY category_id, placement"
        return self._fetch_all(query, (event_id, division_id))

    def get_by_event_and_category(self, event_id: int, category_id: int) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE event_id = ? AND category_id = ? ORDER BY placement"
        return self._fetch_all(query, (event_id, category_id))

    def insert(self, data: Dict[str, Any]) -> Optional[int]:
        required = ['event_id', 'category_id', 'division_id', 'placement', 'entry']
        for f in required:
            if f not in data:
                raise ValueError(f"Missing required field: {f}")
        query = f"""
            INSERT INTO {self.table}
            (event_id, category_id, division_id, placement, entry, points)
            VALUES (?, ?, ?, ?, ?, ?)
        """
        return self._execute_query(query, (
            data['event_id'], data['category_id'], data['division_id'],
            data['placement'], data['entry'], data.get('points', 0)
        ))

    def update(self, result_id: int, data: Dict[str, Any]) -> bool:
        raise NotImplementedError('Results are regenerated, not updated')

    def delete(self, result_id: int) -> bool:
        query = f"DELETE FROM {self.table} WHERE id = ?"
        result = self._execute_query(query, (result_id,))
        return result > 0

    def delete_by_event(self, event_id: int) -> bool:
        return self._execute_query(f"DELETE FROM {self.table} WHERE event_id = ?", (event_id,)) > 0


class AwardAdminFillOptionsRepository(BaseRepository):
    """Repository for award_admin_fill_options table."""

    def __init__(self, db_connection):
        super().__init__(db_connection, 'award_admin_fill_options')

    def get_by_id(self, opt_id: int) -> Optional[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE id = ?"
        return self._fetch_one(query, (opt_id,))

    def get_all(self) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} ORDER BY event_id, category_id, id"
        return self._fetch_all(query)

    def get_by_category(self, category_id: int) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE category_id = ? ORDER BY id"
        return self._fetch_all(query, (category_id,))

    def get_by_event(self, event_id: int) -> List[Dict[str, Any]]:
        query = f"SELECT * FROM {self.table} WHERE event_id = ? ORDER BY category_id, id"
        return self._fetch_all(query, (event_id,))

    def insert(self, data: Dict[str, Any]) -> Optional[int]:
        required = ['event_id', 'category_id', 'option']
        for f in required:
            if f not in data:
                raise ValueError(f"Missing required field: {f}")
        query = f"""
            INSERT INTO {self.table} (event_id, category_id, `option`)
            VALUES (?, ?, ?)
        """
        return self._execute_query(query, (
            data['event_id'], data['category_id'], data['option']
        ))

    def update(self, opt_id: int, data: Dict[str, Any]) -> bool:
        query = f"UPDATE {self.table} SET `option` = ? WHERE id = ?"
        return self._execute_query(query, (data['option'], opt_id)) > 0

    def delete(self, opt_id: int) -> bool:
        query = f"DELETE FROM {self.table} WHERE id = ?"
        result = self._execute_query(query, (opt_id,))
        return result > 0

    def delete_by_category(self, category_id: int) -> bool:
        return self._execute_query(f"DELETE FROM {self.table} WHERE category_id = ?", (category_id,)) > 0

    def delete_by_event(self, event_id: int) -> bool:
        return self._execute_query(f"DELETE FROM {self.table} WHERE event_id = ?", (event_id,)) > 0

class TournamentScheduleSettingsRepository(BaseRepository):
    """Repository for tournament_schedule_settings table."""

    # Per-format presets. Day numbering: 0=Mon .. 6=Sun.
    # Mirrors the ozfortress rulebook (section 7.3).
    FORMAT_DEFAULTS = {
        'sixes': {
            'playable_days': [6, 0, 1, 2, 3],   # Sun–Thu
            'default_day': 3,                    # Thursday
            'deadline_day': 0,                   # Monday
            'deadline_time': '19:00',            # 7PM AEST
        },
        'highlander': {
            'playable_days': [2, 3, 4, 5, 6],    # Wed–Sun
            'default_day': 6,                     # Sunday
            'deadline_day': 3,                    # Thursday
            'deadline_time': '19:00',            # 7PM AEST
        },
    }

    def __init__(self, db_connection):
        super().__init__(db_connection, 'tournament_schedule_settings')

    @classmethod
    def format_defaults(cls, fmt: Optional[str]) -> Optional[Dict[str, Any]]:
        """Return the preset (playable_days, default_day, deadline_day, deadline_time)
        for a format, or None for unknown/'other'."""
        if not fmt:
            return None
        return cls.FORMAT_DEFAULTS.get(fmt.lower())

    def get_by_id(self, settings_id: int) -> Optional[Dict[str, Any]]:
        return self._fetch_one(f"SELECT * FROM {self.table} WHERE id = ?", (settings_id,))

    def get_all(self) -> List[Dict[str, Any]]:
        return self._fetch_all(f"SELECT * FROM {self.table}")

    def get_by_league(self, league_id: int) -> Optional[Dict[str, Any]]:
        return self._fetch_one(f"SELECT * FROM {self.table} WHERE league_id = ?", (league_id,))

    def insert(self, data: Dict[str, Any]) -> Optional[int]:
        if 'league_id' not in data:
            raise ValueError("Missing required field: league_id")
        return self._execute_query(
            f"""INSERT INTO {self.table}
                (league_id, excluded_days, scheduling_enabled, `format`, deadline_day, deadline_time)
                VALUES (?, ?, ?, ?, ?, ?)""",
            (
                data['league_id'], data.get('excluded_days'),
                int(data.get('scheduling_enabled', 0)), data.get('format'),
                data.get('deadline_day'), data.get('deadline_time'),
            )
        )

    def update(self, settings_id: int, data: Dict[str, Any]) -> bool:
        existing = self.get_by_id(settings_id)
        if not existing:
            raise ValueError(f"Settings with ID {settings_id} not found")
        merged = {**existing, **data}
        return self._execute_query(
            f"""UPDATE {self.table}
                SET excluded_days = ?, scheduling_enabled = ?, `format` = ?,
                    deadline_day = ?, deadline_time = ?
                WHERE id = ?""",
            (
                merged.get('excluded_days'), int(merged.get('scheduling_enabled', 0) or 0),
                merged.get('format'), merged.get('deadline_day'),
                merged.get('deadline_time'), settings_id,
            )
        ) > 0

    def delete(self, settings_id: int) -> bool:
        return self._execute_query(f"DELETE FROM {self.table} WHERE id = ?", (settings_id,)) > 0

    def delete_by_league(self, league_id: int) -> bool:
        return self._execute_query(f"DELETE FROM {self.table} WHERE league_id = ?", (league_id,)) > 0


class TeamAvailabilityRepository(BaseRepository):
    """Repository for team_availability table."""

    DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    TIME_SLOTS = ['19:00', '20:00', '21:00']

    def __init__(self, db_connection):
        super().__init__(db_connection, 'team_availability')

    def get_by_id(self, entry_id: int) -> Optional[Dict[str, Any]]:
        return self._fetch_one(f"SELECT * FROM {self.table} WHERE id = ?", (entry_id,))

    def get_all(self) -> List[Dict[str, Any]]:
        return self._fetch_all(f"SELECT * FROM {self.table}")

    def get_by_team(self, team_id: int, league_id: int) -> List[Dict[str, Any]]:
        return self._fetch_all(
            f"SELECT * FROM {self.table} WHERE team_id = ? AND league_id = ? ORDER BY day_of_week, time_slot",
            (team_id, league_id)
        )

    def get_by_league(self, league_id: int) -> List[Dict[str, Any]]:
        return self._fetch_all(
            f"SELECT * FROM {self.table} WHERE league_id = ? ORDER BY team_id, day_of_week, time_slot",
            (league_id,)
        )

    def insert(self, data: Dict[str, Any]) -> Optional[int]:
        for f in ('team_id', 'league_id', 'day_of_week', 'time_slot'):
            if f not in data:
                raise ValueError(f"Missing required field: {f}")
        return self._execute_query(
            f"INSERT IGNORE INTO {self.table} (team_id, league_id, day_of_week, time_slot) VALUES (?, ?, ?, ?)",
            (data['team_id'], data['league_id'], data['day_of_week'], data['time_slot'])
        )

    def set_availability(self, team_id: int, league_id: int, slots: List[tuple]) -> bool:
        """Replace all availability for a team with the given (day, time) slots."""
        self._execute_query(
            f"DELETE FROM {self.table} WHERE team_id = ? AND league_id = ?",
            (team_id, league_id)
        )
        for day, time in slots:
            self.insert({
                'team_id': team_id,
                'league_id': league_id,
                'day_of_week': day,
                'time_slot': time,
            })
        return True

    def update(self, entry_id: int, data: Dict[str, Any]) -> bool:
        existing = self.get_by_id(entry_id)
        if not existing:
            raise ValueError(f"Availability entry with ID {entry_id} not found")
        merged = {**existing, **data}
        return self._execute_query(
            f"UPDATE {self.table} SET day_of_week = ?, time_slot = ? WHERE id = ?",
            (merged['day_of_week'], merged['time_slot'], entry_id)
        ) > 0

    def delete(self, entry_id: int) -> bool:
        return self._execute_query(f"DELETE FROM {self.table} WHERE id = ?", (entry_id,)) > 0

    def delete_by_team(self, team_id: int, league_id: int) -> bool:
        return self._execute_query(
            f"DELETE FROM {self.table} WHERE team_id = ? AND league_id = ?",
            (team_id, league_id)
        ) > 0

    def get_matching(self, team1_id: int, team2_id: int, league_id: int) -> List[Dict[str, Any]]:
        """Find common availability slots between two teams."""
        return self._fetch_all(
            f"""
            SELECT a.day_of_week, a.time_slot
            FROM {self.table} a
            INNER JOIN {self.table} b
                ON a.day_of_week = b.day_of_week AND a.time_slot = b.time_slot
            WHERE a.team_id = ? AND b.team_id = ? AND a.league_id = ? AND b.league_id = ?
            ORDER BY a.day_of_week, a.time_slot
            """,
            (team1_id, team2_id, league_id, league_id)
        )

    def get_team_schedule(self, team_id: int, league_id: int) -> Dict[int, list]:
        """Get availability grouped by day_of_week -> [time_slots]."""
        rows = self.get_by_team(team_id, league_id)
        schedule: Dict[int, list] = {}
        for r in rows:
            schedule.setdefault(r['day_of_week'], []).append(r['time_slot'])
        return schedule


class MatchSchedulesRepository(BaseRepository):
    """Repository for match_schedules table (per-match propose/confirm workflow)."""

    def __init__(self, db_connection):
        super().__init__(db_connection, 'match_schedules')

    def get_by_id(self, match_id: int) -> Optional[Dict[str, Any]]:
        return self.get_by_match_id(match_id)

    def get_by_match_id(self, match_id: int) -> Optional[Dict[str, Any]]:
        return self._fetch_one(f"SELECT * FROM {self.table} WHERE match_id = ?", (match_id,))

    def get_all(self) -> List[Dict[str, Any]]:
        return self._fetch_all(f"SELECT * FROM {self.table}")

    def get_by_league(self, league_id: int) -> List[Dict[str, Any]]:
        return self._fetch_all(f"SELECT * FROM {self.table} WHERE league_id = ?", (league_id,))

    def insert(self, data: Dict[str, Any]) -> Optional[int]:
        for f in ('match_id', 'league_id'):
            if f not in data:
                raise ValueError(f"Missing required field: {f}")
        return self._execute_query(
            f"""INSERT INTO {self.table}
                (match_id, league_id, status, deadline_at)
                VALUES (?, ?, ?, ?)""",
            (
                data['match_id'], data['league_id'],
                data.get('status', 'pending'), data.get('deadline_at'),
            )
        )

    def update(self, match_id: int, data: Dict[str, Any]) -> bool:
        existing = self.get_by_match_id(match_id)
        if not existing:
            raise ValueError(f"Match schedule {match_id} not found")
        merged = {**existing, **data}
        return self._execute_query(
            f"""UPDATE {self.table}
                SET status = ?, proposed_day = ?, proposed_time = ?, proposed_by_team = ?,
                    proposed_by_user = ?, proposed_at = ?, scheduled_at = ?,
                    deadline_at = ?, deadline_flagged = ?
                WHERE match_id = ?""",
            (
                merged['status'], merged.get('proposed_day'), merged.get('proposed_time'),
                merged.get('proposed_by_team'), merged.get('proposed_by_user'),
                merged.get('proposed_at'), merged.get('scheduled_at'),
                merged.get('deadline_at'), int(merged.get('deadline_flagged', 0) or 0),
                match_id,
            )
        ) > 0

    def set_proposal(self, match_id: int, day: int, time: str,
                     team_id: int, user_id: int) -> bool:
        """Record a proposal from one team (status -> proposed)."""
        return self._execute_query(
            f"""UPDATE {self.table}
                SET status = 'proposed', proposed_day = ?, proposed_time = ?,
                    proposed_by_team = ?, proposed_by_user = ?, proposed_at = NOW()
                WHERE match_id = ?""",
            (day, time, team_id, user_id, match_id)
        ) > 0

    def set_confirmed(self, match_id: int, scheduled_at_utc) -> bool:
        """Lock in the agreed time (status -> confirmed)."""
        return self._execute_query(
            f"""UPDATE {self.table}
                SET status = 'confirmed', scheduled_at = ?
                WHERE match_id = ?""",
            (scheduled_at_utc, match_id)
        ) > 0

    def set_flagged(self, match_id: int) -> bool:
        """Mark that the past-deadline warning has been posted."""
        return self._execute_query(
            f"UPDATE {self.table} SET deadline_flagged = 1 WHERE match_id = ?",
            (match_id,)
        ) > 0

    def get_overdue(self, now_utc) -> List[Dict[str, Any]]:
        """Unconfirmed schedules past their deadline whose match is not archived.

        Returns the schedule row plus the match's channel/team columns.
        """
        return self._fetch_all(
            f"""SELECT ms.*, m.channel_id, m.team_home, m.team_away, m.division
                FROM {self.table} ms
                JOIN matches m ON ms.match_id = m.match_id
                WHERE ms.status != 'confirmed'
                  AND ms.deadline_at IS NOT NULL
                  AND ms.deadline_at < ?
                  AND m.archived = 0
                ORDER BY ms.deadline_at""",
            (now_utc,)
        )

    def delete(self, match_id: int) -> bool:
        return self.delete_by_match(match_id)

    def delete_by_match(self, match_id: int) -> bool:
        return self._execute_query(f"DELETE FROM {self.table} WHERE match_id = ?", (match_id,)) > 0

    def delete_by_league(self, league_id: int) -> bool:
        return self._execute_query(f"DELETE FROM {self.table} WHERE league_id = ?", (league_id,)) > 0
