import mariadb

class Database:
    """
    An interface for the Drawbridge Database.

    TODO: CACHED RESPONSES!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! VRY IMPORTENT
    """

    def __init__(self, conn_params):
        self._throw_if_bad_config(conn_params)
        self.conn = mariadb.connect(**conn_params)
        self.cursor = self.conn.cursor()
        # Select the db
        self.cursor.execute(f"USE {conn_params['database']}")

    def _throw_if_bad_config(self, conn_params):
        if "host" not in conn_params: raise KeyError('No Host provided for DB connection')
        if "database" not in conn_params: raise KeyError('No Database provided for DB connection')
        if "user" not in conn_params: raise KeyError('No User provided for DB connection')
        if "password" not in conn_params: raise KeyError('No Password provided for DB connection')

    def close(self):
        self.cursor.close()
        self.conn.close()

    def get_match_details(self,id):
        try:
            query = "SELECT * FROM matches WHERE match_id = %s"
            self.cursor.execute(query, (id,))
            # resolve team_home and team_away
            match = self.cursor.fetchone()
            match['team_home'] = self.get_team(match['team_home'])
            match['team_away'] = self.get_team(match['team_away'])

            return match
            # return self.cursor.fetchone()
        except mariadb.Error as e:
            print(f"Error: {e}")
            return None

    def get_team(self,id):
        try:
            query = "SELECT * FROM teams WHERE team_id = %s"
            self.cursor.execute(query, (id,))
            return self.cursor.fetchone()
        except mariadb.Error as e:
            print(f"Error: {e}")
            return None

    def get_team_by_channel_id(self, channel_id):
        try:
            query = "SELECT * FROM teams WHERE team_channel = %s"
            self.cursor.execute(query, (channel_id,))
            return self.cursor.fetchone()
        except mariadb.Error as e:
            print(f"Error: {e}")
            return None

    def get_all_teams(self):
        try:
            query = "SELECT * FROM teams"
            self.cursor.execute(query)
            return self.cursor.fetchall()
        except mariadb.Error as e:
            print(f"Error: {e}")
            return None

    def get_logs_by_match(self, id):
        try:
            query = "SELECT * FROM logs WHERE match_id = %s"
            self.cursor.execute(query, (id,))
            logs = self.cursor.fetchall()
            return logs;
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
        try:
            query = f"SELECT * FROM logs WHERE team_id = %s & match_id = 0 & team_channel = {team['team_channel']}" # Team Channel Only
            self.cursor.execute(query, (id,))
            logs = self.cursor.fetchall()
            for log in logs:
                log['team'] = team
                # log['match'] = self.get_match_details(log['match_id'])
        except mariadb.Error as e:
            print(f"Error: {e}")
            return None

    def get_match_id_of_channel(self, channel_id):
        try:
            query = "SELECT match_id FROM matches WHERE channel_id = %s"
            self.cursor.execute(query, (channel_id,))
            # if the channel is not in the database, return None
            if self.cursor.rowcount == 0:
                return None
            return self.cursor.fetchone()
        except mariadb.Error as e:
            print(f"Error: {e}")
            return None

    def get_match_by_id(self, match_id):
        try:
            query = "SELECT * FROM matches WHERE match_id = %s"
            self.cursor.execute(query, (match_id,))
            return self.cursor.fetchone()
        except mariadb.Error as e:
            print(f"Error: {e}")
            return None

    def get_all_unarchived_matches(self) -> list:
        try:
            query = "SELECT * FROM matches WHERE archived = 0"
            self.cursor.execute(query)
            return self.cursor.fetchall()
        except mariadb.Error as e:
            print(f"Error: {e}")
            return None

    def get_team_id_of_role(self, role_id):
        try:
            query = "SELECT team_id FROM teams WHERE role_id = %s"
            self.cursor.execute(query, (role_id,))
            return self.cursor.fetchone()
        except mariadb.Error as e:
            print(f"Error: {e}")
            return None

    def get_team_by_id(self, team_id):
        try:
            query = "SELECT * FROM teams LEFT JOIN divisions ON teams.division = divisions.id WHERE team_id = %s"
            self.cursor.execute(query, (team_id,))
            return self.cursor.fetchone()
        except mariadb.Error as e:
            print(f"Error: {e}")
            return None

    def get_div_(self, team_id):
        try:
            query = "SELECT * FROM divisions WHERE team_id = %s"
            self.cursor.execute(query, (team_id,))
            return self.cursor.fetchone()
        except mariadb.Error as e:
            print(f"Error: {e}")
            return None

    def get_team_channels(self):
        try:
            query = "SELECT * FROM teams"
            self.cursor.execute(query)
            return self.cursor.fetchall()
        except mariadb.Error as e:
            print(f"Error: {e}")
            return None

    def insert_log(self, log):
        try:
            query = "INSERT INTO logs (match_id, user_id, user_name, user_nick, user_avatar, team, message_id, message_content, message_additionals, log_type, log_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            self.cursor.execute(query, (log['match_id'], log['user_id'], log['user_name'], log['user_nick'], log['user_avatar'], log['team'], log['message_id'], log['message_content'], log['message_additionals'], log['log_type'], log['log_timestamp']))
            self.conn.commit()
        except mariadb.Error as e:
            print(f"Error: {e}")
            return None

    def insert_div(self, div) -> int:
        try:
            query = "INSERT INTO divisions (division, role_id, category_id) VALUES (?, ?, ?)"
            self.cursor.execute(query, (div['division'], div['role_id'], div['category_id']))
            self.conn.commit()
            return self.cursor.lastrowid
        except mariadb.Error as e:
            print(f"Error: {e}")
            return None

    def insert_team(self, team) -> int:
        try:
            query = "INSERT INTO teams (team_id, role_id, team_channel, division, team_name) VALUES (?, ?, ?, ?, ?)"
            self.cursor.execute(query, (team['team_id'], team['role_id'], team['team_channel'], team['division'], team['team_name']))
            self.conn.commit()
            return self.cursor.lastrowid
        except mariadb.Error as e:
            print(f"Error: {e}")
            return None

    def insert_match(self, match) -> int:
        try:
            query = "INSERT INTO matches (match_id, division, team_home, team_away, channel_id, archived) VALUES (?, ?, ?, ?, ?, ?)"
            self.cursor.execute(query, (match['match_id'], match['division'], match['team_home'], match['team_away'], match['channel_id'], 0))
            self.conn.commit()
            return self.cursor.lastrowid
        except mariadb.Error as e:
            print(f"Error: {e}")
            return None
    def archive_match(self, match_id):
        try:
            query = "UPDATE matches SET archived = 1 WHERE match_id = ?"
            self.cursor.execute(query, (match_id))
            self.conn.commit()
        except mariadb.Error as e:
            print(f"Error: {e}")
            return None


#del mariadb
