import mariadb

class Database:
    """
    An interface for the Drawbridge Database.

    TODO: CACHED RESPONSES!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! VRY IMPORTENT
    """

    def __init__(self, conn_params):
        self._throw_if_bad_config(conn_params)
        conn_params['pool_name'] = 'drawbridge'
        self.pool = mariadb.ConnectionPool(**conn_params)

    def _throw_if_bad_config(self, conn_params):
        if "host" not in conn_params: raise KeyError('No Host provided for DB connection')
        if "database" not in conn_params: raise KeyError('No Database provided for DB connection')
        if "user" not in conn_params: raise KeyError('No User provided for DB connection')
        if "password" not in conn_params: raise KeyError('No Password provided for DB connection')

    def close(self):
        self.pool.close()

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
                #query = "SELECT * FROM teams LEFT JOIN divisions ON teams.division = divisions.id WHERE team_id = %s"
                cursor = conn.cursor()
                query = 'SELECT * FROM teams WHERE team_id=?;'
                cursor.execute(query, (team_id,))
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

    def insert_team(self, team) -> int:
        with self.pool.get_connection() as conn:
            try:
                cursor = conn.cursor()
                query = "INSERT INTO teams (team_id, league_id, role_id, team_channel, division, team_name) VALUES (?, ?, ?, ?, ?, ?)"
                cursor.execute(query, (team['team_id'], team['league_id'], team['role_id'], team['team_channel'], team['division'], team['team_name']))
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
