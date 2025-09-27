"""
Database Module for Drawbridge - Main Database Class
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Main database interface that provides access to all repositories.

:copyright: (c) 2024-present ozfortress
"""

from typing import Dict, Any, Optional, List
from .base import DatabaseConnection, MigrationManager
from .repositories import (
    LeaguesRepository, DivisionsRepository, TeamsRepository,
    MatchesRepository, LogsRepository, SyncedUsersRepository
)


class Database:
    """
    Main database interface for Drawbridge.

    Provides access to all repository classes and handles database setup.

    Example:
        conn_params = {
            'host': 'localhost',
            'database': 'drawbridge',
            'user': 'username',
            'password': 'password'
        }

        db = Database(conn_params)

        # Access repositories
        team = db.teams.get_by_id(123)
        matches = db.matches.get_by_league(1)
    """

    def __init__(self, conn_params: Dict[str, Any], auto_migrate: bool = True):
        """
        Initialize the database connection and repositories.

        Args:
            conn_params: Database connection parameters
            auto_migrate: Whether to automatically run migrations on startup
        """
        # Initialize connection
        self.connection = DatabaseConnection(conn_params)

        # Initialize repositories
        self.leagues = LeaguesRepository(self.connection)
        self.divisions = DivisionsRepository(self.connection)
        self.teams = TeamsRepository(self.connection)
        self.matches = MatchesRepository(self.connection)
        self.logs = LogsRepository(self.connection)
        self.synced_users = SyncedUsersRepository(self.connection)

        # Initialize migration manager
        self.migrations = MigrationManager(self.connection)

        # Run migrations if enabled
        if auto_migrate:
            self.migrations.run_migrations()

    def health_check(self) -> bool:
        """Check if database connection is healthy."""
        return self.connection.health_check()

    def get_stats(self) -> Dict[str, int]:
        """Get database statistics."""
        return {
            'leagues': self.leagues.count(),
            'divisions': self.divisions.count(),
            'teams': self.teams.count(),
            'matches': self.matches.count(),
            'logs': self.logs.count(),
            'synced_users': self.synced_users.count()
        }

    # Convenience methods for common operations
    def get_match_details(self, match_id: int) -> Optional[Dict[str, Any]]:
        """
        Get match details with resolved team information.

        Args:
            match_id: The ID of the match

        Returns:
            Dict with match info and resolved team details
        """
        match = self.matches.get_by_id(match_id)
        if not match:
            return None

        # Resolve team information
        home_team = self.teams.get_by_team_id(match['team_home'])
        away_team = self.teams.get_by_team_id(match['team_away'])

        return {
            **match,
            'home_team_details': home_team,
            'away_team_details': away_team
        }

    # Legacy compatibility methods - map old method names to new repository methods
    def get_match_id_of_channel(self, channel_id: int) -> Optional[Dict[str, Any]]:
        """Legacy compatibility: Get match by channel ID."""
        match = self.matches.get_by_channel_id(channel_id)
        return {'match_id': match['match_id']} if match else None

    def get_team_id_of_channel(self, channel_id: int) -> Optional[Dict[str, Any]]:
        """Legacy compatibility: Get team by channel ID."""
        team = self.teams.get_by_channel_id(channel_id)
        return {'team_id': team['team_id']} if team else None

    def get_team_by_channel_id(self, channel_id: int) -> Optional[Dict[str, Any]]:
        """Get team by Discord channel ID (legacy compatibility)."""
        return self.teams.get_by_channel_id(channel_id)

    def get_match_by_channel_id(self, channel_id: int) -> Optional[Dict[str, Any]]:
        """Get match by Discord channel ID (legacy compatibility)."""
        return self.matches.get_by_channel_id(channel_id)

    def get_match_by_id(self, match_id: int) -> Optional[Dict[str, Any]]:
        """Get match by ID (legacy compatibility)."""
        return self.matches.get_by_id(match_id)

    def get_all_teams(self) -> List[Dict[str, Any]]:
        """Get all teams (legacy compatibility)."""
        return self.teams.get_all()

    def get_all_matches(self) -> List[Dict[str, Any]]:
        """Get all matches (legacy compatibility)."""
        return self.matches.get_all()

    def get_divs_by_league(self, league_id: int) -> List[Dict[str, Any]]:
        """Get divisions by league ID (legacy compatibility)."""
        return self.divisions.get_by_league(league_id)

    def insert_match(self, match_data: Dict[str, Any]) -> int:
        """Insert match (legacy compatibility)."""
        return self.matches.insert(match_data)

    def archive_match(self, match_id: int) -> bool:
        """Archive match (legacy compatibility)."""
        return self.matches.archive(match_id)

    def cleanup_league(self, league_id: int) -> bool:
        """
        Clean up all data for a league (matches, teams, divisions).

        Args:
            league_id: The ID of the league to clean up

        Returns:
            True if successful
        """
        try:
            # Delete in order to respect foreign key constraints
            self.matches.delete_by_league(league_id)
            self.teams.delete_by_league(league_id)
            self.divisions.delete_by_league(league_id)
            self.leagues.delete(league_id)
            return True
        except Exception as e:
            self.connection.logger.error(f"Error cleaning up league {league_id}: {e}")
            return False

    def __del__(self):
        """Cleanup when database instance is destroyed."""
        # Connection pool cleanup is handled automatically by mariadb
        pass


# Legacy compatibility - expose the main Database class as before
__all__ = ['Database']
