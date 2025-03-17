"""
Database Module for Drawbridge
~~~~~~~~~~~~~~~~~~~~~~~

:copyright: (c) 2024-present ozfortress"""

__title__ = 'drawbridge database'
__author__ = 'ozfortress'
__license__ = 'None'
__verison__ = '0.1.0'
__copyright__ = 'Copyright 2024-present ozfortress'

__path__ = __import__('pkgutil').extend_path(__path__, __name__)

if __name__ == '__main__':
    print('This is not a standalone module.')
    raise SystemExit

import mariadb
import re
import logging
import os

class Database:
    """
    An interface for the Drawbridge Database.

    This class when instantiated will create a connection pool to the database, and provide methods to interact with the database.

    Args:
        conn_params (dict): A dictionary containing the connection parameters for the database. For examples, see mariadb.ConnectionPool documentation.

    Raises:
        KeyError: The connection parameters are missing a required key.

    """

    class _BaseDatabaseTable:
        """
        A base class for database tables.

        This class should be inherited by other classes that represent database tables.
        """
        def __init__(self, pool: mariadb.ConnectionPool):
            self.pool = pool
            self.logger = logging.getLogger('drawbridge.database')

        def _query_one(self, query: str, params: tuple) -> dict | None:
            """
            Execute a query that returns one result.

            Args:
                query (str): The query to execute.
                params (tuple): The parameters to pass to the query.

            Returns:
                dict: The result of the query.
            """
            # Should be used for SELECT, LIMIT 1
            with self.pool.get_connection() as conn:
                try:
                    cursor = conn.cursor()
                    cursor.execute(query, params)
                    return cursor.fetchone()
                except mariadb.Error as e:
                    self.logger.error(f"Error fetching one with query `{query}` and params `{params}`: {e}", exc_info=True)
                    return None

        def _query_all(self, query: str, params: tuple) -> list[dict] | None:
            """
            Execute a query that returns many results.

            Args:
                query (str): The query to execute.
                params (tuple): The parameters to pass to the query.

            Returns:
                list: A list of the results of the query.
            """
            # Should be used for SELECT, SELECT COUNT, etc.
            with self.pool.get_connection() as conn:
                try:
                    cursor = conn.cursor()
                    cursor.execute(query, params)
                    return cursor.fetchall()
                except mariadb.Error as e:
                    self.logger.error(f"Error fetching all with query `{query}` and params `{params}`: {e}", exc_info=True)
                    return None

        def _execute(self, query: str, params: tuple) -> int | None:
            """
            Execute a query that does not return a result.

            Args:
                query (str): The query to execute.
                params (tuple): The parameters to pass to the query.

            Returns:
                int: The last row id of the query.
            """
            # Should be used for INSERT, UPDATE, DELETE
            with self.pool.get_connection() as conn:
                try:
                    cursor = conn.cursor()
                    cursor.execute(query, params)
                    conn.commit()
                    return cursor.lastrowid
                except mariadb.Error as e:
                    self.logger.error(f"Error committing with query `{query}` and params `{params}`: {e}", exc_info=True)
                    return None

    class Teams(_BaseDatabaseTable):
        def __init__(self, pool):
            super().__init__(pool)
            self.table = 'teams'

        def get(self, id):
            """
            Get a team by its ID.

            Args:
                id (int): The ID of the team. Not to be confused with Roster
            """
            query = f"SELECT * FROM {self.table} WHERE team_id=?"
            return self._query_one(query, (id,))

        def get_by_channel_id(self, channel_id):
            """
            Get a team by its Discord channel ID.

            Args:
                channel_id (int): The ID of the Discord channel.
            """
            query = f"SELECT * FROM {self.table} WHERE team_channel=?"
            return self._query_one(query, (channel_id,))

        def get_by_league(self, league_id):
            """
            Get all teams in a league.

            Args:
                league_id (int): The ID of the league.
            """
            query = f"SELECT * FROM {self.table} WHERE league_id=?"
            return self._query_all(query, (league_id,))

        def get_all(self):
            """
            Get all teams.
            """
            query = f"SELECT * FROM {self.table}"
            return self._query_all(query, ())

        def insert(self, team) -> int:
            """
            Insert a team into the database.

            Args:
                team (dict): The team to insert.
            """
            query = f"INSERT INTO {self.table} (team_id, league_id, role_id, team_channel, division, team_name) VALUES (?, ?, ?, ?, ?, ?)"
            return self._execute(query, (team['team_id'], team['league_id'], team['role_id'], team['team_channel'], team['division'], team['team_name']))

        def delete(self, team_id):
            """
            Delete a team by its ID.

            Args:
                team_id (int): The ID of the team.
            """
            query = f"DELETE FROM {self.table} WHERE team_id=?"
            return self._execute(query, (team_id,))

        def delete_by_league(self, league_id):
            """
            Delete all teams in a league.

            Args:
                league_id (int): The ID of the league.
            """
            query = f"DELETE FROM {self.table} WHERE league_id=?"
            return self._execute(query, (league_id,))

        def update(self, team):
            """
            Update a team.

            Args:
                team (dict): The team to update.

            Raises:
                KeyError: If team_id is not passed in.
                ValueError: If team_id is not found in the database.
            """
            # this is a strange one, we need to only update the fields that are passed in
            # raise an error if team_id is not passed in
            if 'team_id' not in team:
                raise KeyError('team_id not passed in')
            query = f"SELECT * FROM {self.table} WHERE team_id=?"
            old_team = self._query_one(query, (team['team_id'],))
            if old_team is None:
                raise ValueError('team_id not found in database')

            query = f"UPDATE {self.table} SET league_id=?, role_id=?, team_channel=?, division=?, team_name=? WHERE team_id=?"
            # Merge the two dicts together
            for key, value in old_team.items():
                if key not in team:
                    team[key] = value
            return self._execute(query, (team['league_id'], team['role_id'], team['team_channel'], team['division'], team['team_name'], team['team_id']))

        def count(self):
            """
            Get the number of teams in the database.
            """
            query = f"SELECT COUNT(*) FROM {self.table}"
            return self._query_one(query, ())

    class Divisions(_BaseDatabaseTable):
        def __init__(self, pool):
            super().__init__(pool)
            self.table = 'divisions'

        def get(self, id):
            """
            Get a division by its ID.

            Args:
                id (int): The ID of the division.
            """
            query = f"SELECT * FROM {self.table} WHERE id=?"
            return self._query_one(query, (id,))

        def get_all(self):
            """
            Get all divisions.
            """
            query = f"SELECT * FROM {self.table}"
            return self._query_all(query, ())

        def get_by_league(self, league_id):
            """
            Get all divisions in a league.

            Args:
                league_id (int): The ID of the league.
            """
            query = f"SELECT * FROM {self.table} WHERE league_id=?"
            return self._query_all(query, (league_id,))

        def insert(self, div) -> int:
            """
            Insert a division into the database.

            Args:
                div (dict): The division to insert.
            """
            query = f"INSERT INTO {self.table} (league_id, division_name, role_id, category_id) VALUES (?, ?, ?, ?)"
            return self._execute(query, (div['league_id'], div['division_name'], div['role_id'], div['category_id']))

        def delete(self, id):
            """
            Delete a division by its ID.

            Args:
                id (int): The ID of the division.
            """
            query = f"DELETE FROM {self.table} WHERE id=?"
            return self._execute(query, (id,))

        def delete_by_league(self, league_id):
            """
            Delete all divisions in a league.

            Args:
                league_id (int): The ID of the league.
            """
            query = f"DELETE FROM {self.table} WHERE league_id=?"
            return self._execute(query, (league_id,))

        def update(self, div):
            """
            Update a division.

            Args:
                div (dict): The division to update.

            Raises:
                KeyError: If id is not passed in.
                ValueError: If id is not found in the database.
            """
            # this is a strange one, we need to only update the fields that are passed in
            # raise an error if id is not passed in
            if 'id' not in div:
                raise KeyError('id not passed in')
            query = f"SELECT * FROM {self.table} WHERE id=?"
            old_div = self._query_one(query, (div['id'],))
            if old_div is None:
                raise ValueError('id not found in database')

            query = f"UPDATE {self.table} SET league_id=?, division_name=?, role_id=?, category_id=? WHERE id=?"
            # Merge the two dicts together
            for key, value in old_div.items():
                if key not in div:
                    div[key] = value
            return self._execute(query, (div['league_id'], div['division_name'], div['role_id'], div['category_id'], div['id']))

        def count(self):
            """
            Get the number of divisions in the database.
            """
            query = f"SELECT COUNT(*) FROM {self.table}"
            return self._query_one(query, ())

        def count_by_league(self, league_id):
            """
            Get the number of divisions in a league.

            Args:
                league_id (int): The ID of the league.
            """
            query = f"SELECT COUNT(*) FROM {self.table} WHERE league_id=?"
            return self._query_one(query, (league_id,))

    class Matches(_BaseDatabaseTable):
        def __init__(self, pool):
            super().__init__(pool)
            self.table = 'matches'

        def get(self, id):
            """
            Get a match by its ID.

            Args:
                id (int): The ID of the match.
            """
            query = f"SELECT * FROM {self.table} WHERE match_id=?"
            return self._query_one(query, (id,))

        def get_all(self):
            """
            Get all matches.
            """
            query = f"SELECT * FROM {self.table}"
            return self._query_all(query, ())

        def get_by_league(self, league_id):
            """
            Get all matches in a league.

            Args:
                league_id (int): The ID of the league.
            """
            query = f"SELECT * FROM {self.table} WHERE league_id=?"
            return self._query_all(query, (league_id,))

        def get_by_division(self, division):
            """
            Get all matches in a division.

            Args:
                division (int): The ID of the division.
            """
            query = f"SELECT * FROM {self.table} WHERE division=?"
            return self._query_all(query, (division,))

        def get_by_channel_id(self, channel_id):
            """
            Get a match by its Discord channel ID.

            Args:
                channel_id (int): The ID of the Discord channel.
            """
            query = f"SELECT * FROM {self.table} WHERE channel_id=?"
            return self._query_one(query, (channel_id,))

        def insert(self, match) -> int:
            """
            Insert a match into the database.

            Args:
                match (dict): The match to insert.
            """
            query = f"INSERT INTO {self.table} (match_id, division, team_home, team_away, channel_id, archived, league_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
            return self._execute(query, (match['match_id'], match['division'], match['team_home'], match['team_away'], match['channel_id'], 0, match['league_id']))

        def delete(self, id):
            """
            Delete a match by its ID.

            Args:
                id (int): The ID of the match.
            """
            query = f"DELETE FROM {self.table} WHERE match_id=?"
            return self._execute(query, (id,))

        def delete_by_league(self, league_id):
            """
            Delete all matches in a league.

            Args:
                league_id (int): The ID of the league.
            """
            query = f"DELETE FROM {self.table} WHERE league_id=?"
            return self._execute

        def update(self, match):
            """
            Update a match.

            Args:
                match (dict): The match to update.

            Raises:
                KeyError: If match_id is not passed in.
                ValueError: If match_id is not found in the database.
            """
            # this is a strange one, we need to only update the fields that are passed in
            # raise an error if match_id is not passed in
            if 'match_id' not in match:
                raise KeyError('match_id not passed in')
            query = f"SELECT * FROM {self.table} WHERE match_id=?"
            old_match = self._query_one(query, (match['match_id'],))
            if old_match is None:
                raise ValueError('match_id not found in database')

            query = f"UPDATE {self.table} SET division=?, team_home=?, team_away=?, channel_id=?, archived=?, league_id=? WHERE match_id=?"
            # Merge the two dicts together
            for key, value in old_match.items():
                if key not in match:
                    match[key] = value
            return self._execute(query, (match['division'], match['team_home'], match['team_away'], match['channel_id'], match['archived'], match['league_id'], match['match_id']))

        def count(self):
            """
            Get the number of matches in the database.
            """
            query = f"SELECT COUNT(*) FROM {self.table}"
            return self._query_one(query, ())

        def count_by_league(self, league_id):
            """
            Get the number of matches in a league.

            Args:
                league_id (int): The ID of the league.
            """
            query = f"SELECT COUNT(*) FROM {self.table} WHERE league_id=?"
            return self._query_one(query, (league_id,))

        def count_by_division(self, division):
            """
            Get the number of matches in a division.

            Args:
                division (int): The ID of the division.
            """
            query = f"SELECT COUNT(*) FROM {self.table} WHERE division=?"
            return self._query_one(query, (division,))

    class Leagues(_BaseDatabaseTable):
        def __init__(self, pool):
            super().__init__(pool)
            self.table = 'leagues'

        def get(self, id):
            query = f"SELECT * FROM {self.table} WHERE league_id=?"
            return self._query_one(query, (id,))

        def get_all(self):
            query = f"SELECT * FROM {self.table}"
            return self._query_all(query, ())

        def insert(self, league) -> int:
            query = f"INSERT INTO {self.table} (league_id, league_name, league_short, league_description, league_icon) VALUES (?, ?, ?, ?, ?)"
            return self._execute(query, (league['league_id'], league['league_name'], league['league_short'], league['league_description'], league['league_icon']))

        def delete(self, id):
            query = f"DELETE FROM {self.table} WHERE league_id=?"
            return self._execute(query, (id,))

        def update(self, league):
            if 'league_id' not in league:
                raise KeyError('league_id not passed in')
            query = f"SELECT * FROM {self.table} WHERE league_id=?"
            old_league = self._query_one(query, (league['league_id'],))
            if old_league is None:
                raise ValueError('league_id not found in database')
            query = f"UPDATE {self.table} SET league_name=?, league_short=?, league_description=?, league_icon=? WHERE league_id=?"
            for key, value in old_league.items():
                if key not in league:
                    league[key] = value
            return self._execute(query, (league['league_name'], league['league_short'], league['league_description'], league['league_icon'], league['league_id']))

    class Teams(_BaseDatabaseTable):
        def __init__(self, pool):
            super().__init__(pool)
            self.table = 'teams'

        def get(self, id):
            query = f"SELECT * FROM {self.table} WHERE team_id=?"
            return self._query_one(query, (id,))

        def get_by_team_id(self, team_id):
            query = f"SELECT * FROM {self.table} WHERE team_id=?"
            return self._query_all(query, (team_id,))

        def get_by_league_id(self, league_id):
            query = f"SELECT * FROM {self.table} WHERE league_id=?"
            return self._query_all(query, (league_id,))

        def get_by_channel_id(self, channel_id):
            query = f"SELECT * FROM {self.table} WHERE team_channel=?"
            return self._query_one(query, (channel_id,))

        def get_by_role_id(self, role_id):
            query = f"SELECT * FROM {self.table} WHERE role_id=?"
            return self._query_one(query, (role_id,))

        def get_by_division(self, division):
            query = f"SELECT * FROM {self.table} WHERE division=?"
            return self._query_all(query, (division,))

        def get_all(self):
            query = f"SELECT * FROM {self.table}"
            return self._query_all(query, ())

        def insert(self, team) -> int:
            query = f"INSERT INTO {self.table} (team_id, league_id, role_id, team_channel, division, team_name) VALUES (?, ?, ?, ?, ?, ?)"
            return self._execute(query, (team['team_id'], team['league_id'], team['role_id'], team['team_channel'], team['division'], team['team_name']))

        def delete(self, team_id):
            query = f"DELETE FROM {self.table} WHERE team_id=?"
            return self._execute(query, (team_id,))

        def delete_by_league(self, league_id):
            query = f"DELETE FROM {self.table} WHERE league_id=?"
            return self._execute(query, (league_id,))

        def update(self, team):
            if 'roster_id' not in team:
                raise KeyError('roster_id not passed in')
            if 'team_id' not in team:
                raise KeyError('team_id not passed in')
            query = f"SELECT * FROM {self.table} WHERE team_id=?"
            old_team = self._query_one(query, (team['team_id'],))
            if old_team is None:
                raise ValueError('team_id not found in database')
            query = f"UPDATE {self.table} SET league_id=?, role_id=?, team_channel=?, division=?, team_name=? WHERE team_id=?"
            for key, value in old_team.items():
                if key not in team:
                    team[key] = value
            return self._execute(query, (team['league_id'], team['role_id'], team['team_channel'], team['division'], team['team_name'], team['team_id']))


        def count(self):
            query = f"SELECT COUNT(*) FROM {self.table}"
            return self._query_one(query, ())

        def count_by_league(self, league_id):
            query = f"SELECT COUNT(*) FROM {self.table} WHERE league_id=?"
            return self._query_one(query, (league_id,))

        def count_by_division(self, division):
            query = f"SELECT COUNT(*) FROM {self.table} WHERE division=?"
            return self._query_one

    class Logs(_BaseDatabaseTable):
        def __init__(self, pool):
            super().__init__(pool)
            self.table = 'logs'

        def get(self, id):
            query = f"SELECT * FROM {self.table} WHERE id=?"
            return self._query_one(query, (id,))

        def get_by_match_id(self, match_id):
            query = f"SELECT * FROM {self.table} WHERE match_id=?"
            return self._query_all(query, (match_id,))

        def get_by_team_id(self, team_id):
            query = f"SELECT * FROM {self.table} WHERE team_id=?"
            return self._query_all(query, (team_id,))

        def get_all(self):
            query = f"SELECT * FROM {self.table}"
            return self._query_all(query, ())

        def insert(self, log) -> int:
            query = f"INSERT INTO {self.table} (match_id, user_id, user_name, user_nick, user_avatar, team_id, message_id, message_content, message_additionals, log_type, log_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            return self._execute(query, (log['match_id'], log['user_id'], log['user_name'], log['user_nick'], log['user_avatar'], log['team_id'], log['message_id'], log['message_content'], log['message_additionals'], log['log_type'], log['log_timestamp']))

        def delete(self, id):
            query = f"DELETE FROM {self.table} WHERE id=?"
            return self._execute(query, (id,))

        def delete_by_match_id(self, match_id):
            if 'match_id' == 0:
                raise ValueError('match_id cannot be 0')
            query = f"DELETE FROM {self.table} WHERE match_id=?"
            return self._execute(query, (match_id,))

        def delete_by_team_id(self, team_id):
            if 'team_id' == 0:
                raise ValueError('team_id cannot be 0')
            query = f"DELETE FROM {self.table} WHERE team_id=?"
            return self._execute(query, (team_id,))

        def update(self, log):
            raise NotImplementedError('Update not implemented for logs - logs are designed to be immutable')

        def count(self):
            query = f"SELECT COUNT(*) FROM {self.table}"
            return self._query_one(query, ())

        def count_by_match_id(self, match_id):
            query = f"SELECT COUNT(*) FROM {self.table} WHERE match_id=?"
            return self._query_one(query, (match_id,))

        def count_by_team_id(self, team_id):
            query = f"SELECT COUNT(*) FROM {self.table} WHERE team_id=?"
            return self._query_one(query, (team_id,))

        def delete(self, id):
            raise NotImplementedError('Delete not implemented for logs - logs are designed to be kept indefinitely')

        def delete_by_match_id(self, match_id):
            raise NotImplementedError('Delete not implemented for logs - logs are designed to be kept indefinitely')

        def delete_by_team_id(self, team_id):
            raise NotImplementedError('Delete not implemented for logs - logs are designed to be kept indefinitely')

    def __init__(self, conn_params):
        self._throw_if_bad_config(conn_params)
        if not conn_params.get('pool_name'):
            conn_params['pool_name'] = 'drawbridge'
        self.pool = mariadb.ConnectionPool(**conn_params)
        self.logger = logging.getLogger('drawbridge.database')
        # self._run_migrations() # TODO: WIP

        # instantiate the tables
        self.teams = self.Teams(self.pool)
        self.divisions = self.Divisions(self.pool)
        self.matches = self.Matches(self.pool)
        self.logs = self.Logs(self.pool)
        self.leagues = self.Leagues(self.pool)

    def __del__(self):
        self._close()

    def _health_check(self):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                cursor.execute("SELECT 1")
                return True
            except mariadb.Error as e:
                print(f"Error: {e}")
                return False

    def _throw_if_bad_config(self, conn_params):
        if "host" not in conn_params: raise KeyError('No Host provided for DB connection')
        if "database" not in conn_params: raise KeyError('No Database provided for DB connection')
        if "user" not in conn_params: raise KeyError('No User provided for DB connection')
        if "password" not in conn_params: raise KeyError('No Password provided for DB connection')

    def _create_db_if_not_exists(self):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                # test the DB has been created
                cursor.execute("SHOW TABLES")
                # if the DB is empty, create the tables
                if cursor.rowcount == 0:
                    query = ''
                    for line in open('db.sql'):
                        if re.match(r'--', line): continue #ignore comments
                        if not re.search(r';$', line): query = query + line
                        else:
                            query = query + line
                            try:
                                cursor.execute(query)
                            except Exception as e:
                                print(f"Error: {e}")
                            query = ''
            except mariadb.Error as e:
                print(f"Error: {e}")

    def _close(self):
        # self.pool.close()
        pass

    def _run_migrations(self):
        # Check state of database
        with self.pool.get_connection() as conn:
            version = 0
            # Check if the database is empty
            cursor = conn.cursor()
            cursor.execute("SHOW TABLES")
            if cursor.rowcount == 0:
                # Empty database, assume verison 0
                version = 0
            else:
                # Check if the migrations table exists
                cursor.execute("SHOW TABLES LIKE 'schema_migrations'")
                if cursor.rowcount == 0:
                    # No migrations table, assume version 0
                    version = 0
                else:
                    # Migrations table exists, get the version
                    cursor.execute("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
                    # The highest version in the table is the current version
                    version = cursor.fetchone()
                    if version is None:
                        version = 0

            # The migrations folder will have sql files named like 1.migration_name.sql
            # We will run all migrations from the current version to the latest version
            # We will also log the migration in the schema_migrations table

            # Get the list of migration files
            migrations = []
            # get all .sql files in migrations
            for file in os.listdir('migrations'):
                if file.endswith('.sql'):
                    migrations.append(file)

            # Sort the migrations by the version number
            migrations.sort()

            # Run the migrations
            for migration in migrations:
                if int(migration.split('.')[0]) > version:
                    # Run the migration
                    with open(f'migrations/{migration}') as file:
                        query = file.read()
                        cursor.execute(query)
                    # Log the migration
                    cursor.execute("INSERT INTO schema_migrations (version) VALUES (?)", (int(migration.split('.')[0]),))

    def get_match_details(self,id):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = "SELECT * FROM matches WHERE match_id=?"
                cursor.execute(query, (id,))
                # resolve team_home and team_away
                match = cursor.fetchone()
                #match['team_home'] = self.get_team(match[2])
                #match['team_away'] = self.get_team(match[3])

                return match
                # return self.cursor.fetchone()
            except mariadb.Error as e:
                print(f"Error: {e}")
                return None

    def get_team(self,id):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = "SELECT * FROM teams WHERE team_id = %s"
                cursor.execute(query, (id,))
                return cursor.fetchone()
            except mariadb.Error as e:
                print(f"Error: {e}")
                return None

    def get_team_by_channel_id(self, channel_id):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = "SELECT * FROM teams WHERE team_channel = %s"
                cursor.execute(query, (channel_id,))
                return cursor.fetchone()
            except mariadb.Error as e:
                print(f"Error: {e}")
                return None

    def get_all_teams(self):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = "SELECT * FROM teams"
                cursor.execute(query)
                return cursor.fetchall()
            except mariadb.Error as e:
                print(f"Error: {e}")
                return None

    def get_logs_by_match(self, id):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = "SELECT * FROM logs WHERE match_id = %s"
                cursor.execute(query, (id,))
                logs = cursor.fetchall()
                return logs
            # iterate through logs, resolve players and teams
            # match = self.get_match_details(id)
            # teams = []
            # for log in logs:
            #     log['match'] = match # Searching by match, so they all have the same match
            #     if log['team_id'] not in teams and (log['team_id'] is not None or log['team_id'] != '' or log['team_id'] != '0'):
            #         teams[log['team_id']] = self.get_team(log['team_id']) # cache the team
            #     if (log['team_id'] is not None or log['team_id'] != '' or log['team_id'] != '0'):
            #         log['team'] = teams[log['team_id']]
            #     else:
            #         log['team'] = None # TODO: Handle admins and casters


            except mariadb.Error as e:
                print(f"Error: {e}")
                return None

    def get_logs_by_team(self, id):
        team = self.get_team(id)
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = f"SELECT * FROM logs WHERE team_id = %s & match_id = 0 & team_channel = {team['team_channel']}" # Team Channel Only
                cursor.execute(query, (id,))
                logs = cursor.fetchall()
                for log in logs:
                    log['team'] = team
                    # log['match'] = self.get_match_details(log['match_id'])
            except mariadb.Error as e:
                print(f"Error: {e}")
                return None

    def get_match_id_of_channel(self, channel_id):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = "SELECT match_id FROM matches WHERE channel_id = %s"
                cursor.execute(query, (channel_id,))
                # if the channel is not in the database, return None
                if cursor.rowcount == 0:
                    return None
                return cursor.fetchone()
            except mariadb.Error as e:
                print(f"Error: {e}")
                return None

    def get_match_by_id(self, match_id):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = "SELECT * FROM matches WHERE match_id = %s"
                cursor.execute(query, (match_id,))
                return cursor.fetchone()
            except mariadb.Error as e:
                print(f"Error: {e}")
                return None

    def get_all_unarchived_matches(self) -> list:
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = "SELECT * FROM matches WHERE archived = 0"
                cursor.execute(query)
                return cursor.fetchall()
            except mariadb.Error as e:
                print(f"Error: {e}")
                return None

    def get_team_id_of_role(self, role_id):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = "SELECT team_id FROM teams WHERE role_id = %s"
                cursor.execute(query, (role_id,))
                return cursor.fetchone()
            except mariadb.Error as e:
                print(f"Error: {e}")
                return None

    def get_team_id_of_channel(self, channel_id):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = 'SELECT team_id FROM teams WHERE team_channel=?;'
                cursor.execute(query, (channel_id,))
                return cursor.fetchone()
            except mariadb.Error as e:
                print(f"Error: {e}")
                return None

    def get_team_by_id(self, team_id):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = 'SELECT * FROM teams WHERE team_id=?;'
                cursor.execute(query, (team_id,))
                return cursor.fetchone()
            except mariadb.Error as e:
                print(f"Error: {e}")
                return None
            
    # to fix ambiguity for a team signed up for more than 1 league
    def get_team_by_id_and_league(self, team_id, league_id):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = 'SELECT * FROM teams WHERE team_id=? and league_id=?;'
                cursor.execute(query, (team_id,league_id))
                return cursor.fetchone()
            except mariadb.Error as e:
                print(f"Error: {e}")
                return None

    def get_divs_by_league(self, league_id):
        with self.pool.get_connection() as conn:
            try:
                query = "SELECT * FROM divisions WHERE league_id=?"
                cursor = conn.cursor()
                cursor.execute(query, (league_id,))
                return cursor.fetchall()
            except mariadb.Error as e:
                print(f"Error in get_divs_by_league: {e}")
                return None

    def get_teams_by_league(self, league_id):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = 'SELECT * FROM teams WHERE league_id=?'
                cursor.execute(query, (league_id,))
                return cursor.fetchall()
            except mariadb.Error as e:
                print(f'Error in get_teams_by_league: {e}')
                return None

    def get_matches_by_league(self, league_id):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = 'SELECT * FROM matches WHERE league_id=?'
                cursor.execute(query, (league_id,))
                return cursor.fetchall()
            except mariadb.Error as e:
                print(f'Error in get_matches_by_league: {e}')
                return None

    def get_team_channels(self):
        with self.pool.get_connection() as conn:
            try:
                query = "SELECT * FROM teams"
                cursor = conn.cursor()
                cursor.execute(query)
                return cursor.fetchall()
            except mariadb.Error as e:
                print(f"Error: {e}")
                return None

    def insert_log(self, log):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = "INSERT INTO logs (match_id, user_id, user_name, user_nick, user_avatar, team_id, message_id, message_content, message_additionals, log_type, log_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                cursor.execute(query, (log['match_id'], log['user_id'], log['user_name'], log['user_nick'], log['user_avatar'], log['team_id'], log['message_id'], log['message_content'], log['message_additionals'], log['log_type'], log['log_timestamp']))
                conn.commit()
            except mariadb.Error as e:
                print(f"Error: {e}")
                return None

    def insert_div(self, div) -> int:
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = "INSERT INTO divisions (league_id, division_name, role_id, category_id) VALUES (?, ?, ?, ?)"
                cursor.execute(query, (div['league_id'], div['division_name'], div['role_id'], div['category_id']))
                conn.commit()
                return cursor.lastrowid
            except mariadb.Error as e:
                print(f"Error at insert_div: {e}")
                return None

    def get_div_by_name(self, div_name):
        with self.pool.get_connection() as conn:
            try:
                query = 'SELECT * FROM divisions WHERE division_name=?;'
                cursor = conn.cursor()
                cursor.execute(query, (div_name,))
                return cursor.fetchone()
            except mariadb.Error as e:
                print(f'Error at get_div_by_name: {e}')
                return None

    def get_div_by_id (self, div_id):
        with self.pool.get_connection() as conn:
            try:
                query = 'SELECT * FROM divisions WHERE id=?;'
                cursor = conn.cursor()
                cursor.execute(query, (div_id,))
                return cursor.fetchone()
            except mariadb.Error as e:
                print(f'Error at get_div_by_id: {e}')
                return None

    def insert_team(self, team) -> int:
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = "INSERT INTO teams (roster_id, team_id, league_id, role_id, team_channel, division, team_name) VALUES (?, ?, ?, ?, ?, ?, ?)"
                cursor.execute(query, (team['roster_id'], team['team_id'], team['league_id'], team['role_id'], team['team_channel'], team['division'], team['team_name']))
                conn.commit()
                return cursor.lastrowid
            except mariadb.Error as e:
                print(f"Error at insert_team: {e}")
                return None

    def insert_match(self, match) -> int:
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = "INSERT INTO matches (match_id, division, team_home, team_away, channel_id, archived, league_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
                cursor.execute(query, (match['match_id'], match['division'], match['team_home'], match['team_away'], match['channel_id'], 0, match['league_id']))
                conn.commit()
                return cursor.lastrowid
            except mariadb.Error as e:
                print(f"Error: {e}")
                return None

    def archive_match(self, match_id):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = "UPDATE matches SET archived = 1 WHERE match_id = ?"
                cursor.execute(query, (match_id,))
                conn.commit()
            except mariadb.Error as e:
                print(f"Error: {e}")
                return None

    # cleanup stuff

    def get_match_channels_by_league(self, league_id):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = 'SELECT channel_id FROM matches WHERE league_id=?;'
                cursor.execute(query, (league_id,))
                return cursor.fetchall()
            except mariadb.Error as e:
                print(f'Error in get_match_channels_by_league: {e}')
                return None

    def delete_divisions_by_league(self, league_id):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = 'DELETE FROM divisions WHERE league_id=?'
                cursor.execute(query, (league_id,))
                conn.commit()
                return cursor.lastrowid
            except mariadb.Error as e:
                print(f'Error: {e}')
                return None

    def delete_teams_by_league(self, league_id):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = 'DELETE FROM teams WHERE league_id=?'
                cursor.execute(query, (league_id,))
                conn.commit()
                return cursor.lastrowid
            except mariadb.Error as e:
                print(f'Error: {e}')
                return None

    def delete_matches_by_league(self, league_id):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = 'DELETE FROM matches WHERE league_id=?'
                cursor.execute(query, (league_id,))
                conn.commit()
                return cursor.lastrowid
            except mariadb.Error as e:
                print(f'Error: {e}')
                return None

    def get_no_of_matches(self):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = 'SELECT COUNT(*) FROM matches;'
                cursor.execute(query)
                return cursor.fetchone()
            except mariadb.Error as e:
                print(f'Error: {e}')
                return None

    def get_no_of_teams(self):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = 'SELECT COUNT(*) FROM teams;'
                cursor.execute(query)
                return cursor.fetchone()
            except mariadb.Error as e:
                print(f'Error: {e}')
                return None

    def get_no_of_divisions(self):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = 'SELECT COUNT(*) FROM divisions;'
                cursor.execute(query)
                return cursor.fetchone()
            except mariadb.Error as e:
                print(f'Error: {e}')
                return None


    def get_no_of_logs(self):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = 'SELECT COUNT(*) FROM logs;'
                cursor.execute(query)
                return cursor.fetchone()
            except mariadb.Error as e:
                print(f'Error: {e}')
                return None

    def check_link_status(self, user_id):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = 'SELECT link_status FROM linked_users WHERE discord_id = ?'
                cursor.execute(query, (user_id,))
                return cursor.fetchone()
            except mariadb.Error as e:
                print(f'Error: {e}')
                return None

    def check_for_linked_steamid(self, steam_id):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = 'SELECT * FROM linked_users WHERE steam_id = ?'
                cursor.execute(query, (steam_id,))
                return cursor.fetchone()
            except mariadb.Error as e:
                print(f'Error: {e}')
                return None

    def start_link(self, user_id, link_code):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = 'INSERT INTO linked_users (discord_id, link_code, link_status) VALUES (?, ?, ?)'
                cursor.execute(query, (user_id, link_code, 0))
                conn.commit()
            except mariadb.Error as e:
                print(f'Error: {e}')
                return None

    def link_steam_to_discord(self,steam_id, link_code, cit_id):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = 'UPDATE linked_users SET steam_id = ?, link_status = ?, citadel_id = ? WHERE link_code = ?'
                status = 1
                if cit_id is None:
                    status = 2
                cursor.execute(query, (steam_id, status, cit_id, link_code))
                conn.commit()
            except mariadb.Error as e:
                print(f'Error: {e}')
                return None

    def get_matches_not_yet_archived(self):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = 'SELECT * FROM matches WHERE archived = 0 AND channel_id IS NOT NULL;'
                cursor.execute(query)
                return cursor.fetchall()
            except mariadb.Error as e:
                print(f'Error: {e}')
                return None

    def get_all_teams(self):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = 'SELECT * FROM teams;'
                cursor.execute(query)
                return cursor.fetchall()
            except mariadb.Error as e:
                print(f'Error: {e}')
                return None

    def get_all_matches(self):
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = 'SELECT * FROM matches;'
                cursor.execute(query)
                return cursor.fetchall()
            except mariadb.Error as e:
                print(f'Error: {e}')
                return None