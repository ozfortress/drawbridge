"""
Database Module for Drawbridge
~~~~~~~~~~~~~~~~~~~~~~~

A clean, modern database interface for the Drawbridge Discord bot.

:copyright: (c) 2024-present ozfortress
"""

__title__ = 'drawbridge database'
__author__ = 'ozfortress'
__license__ = 'None'
__version__ = '0.2.0'  # Updated version to reflect the improvements
__copyright__ = 'Copyright 2024-present ozfortress'

# Main imports
from .database import Database
from .base import DatabaseError, DatabaseConnection
from .repositories import (
    LeaguesRepository, DivisionsRepository, TeamsRepository,
    MatchesRepository, LogsRepository, SyncedUsersRepository
)

# Make the Database class available as the main export
__all__ = [
    'Database',
    'DatabaseError',
    'DatabaseConnection',
    'LeaguesRepository',
    'DivisionsRepository',
    'TeamsRepository',
    'MatchesRepository',
    'LogsRepository',
    'SyncedUsersRepository'
]

# Prevent direct execution
if __name__ == '__main__':
    print('This is not a standalone module.')
    raise SystemExit
