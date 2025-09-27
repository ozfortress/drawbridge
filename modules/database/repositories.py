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
        required_fields = ['league_id', 'league_name', 'league_short', 'league_description', 'league_icon']

        if not all(field in league for field in required_fields):
            raise ValueError(f"Missing required fields: {required_fields}")

        query = f"""
            INSERT INTO {self.table} (league_id, league_name, league_short, league_description, league_icon)
            VALUES (?, ?, ?, ?, ?)
        """
        return self._execute_query(query, (
            league['league_id'], league['league_name'], league['league_short'],
            league['league_description'], league['league_icon']
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
            SET league_name = ?, league_short = ?, league_description = ?, league_icon = ?
            WHERE league_id = ?
        """
        result = self._execute_query(query, (
            updated_data['league_name'], updated_data['league_short'],
            updated_data['league_description'], updated_data['league_icon'],
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
