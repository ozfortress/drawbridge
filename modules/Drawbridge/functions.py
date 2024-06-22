import modules.database as database
import modules.citadel as citadel
import discord
import logging
import time

class Functions:
    """
    Drawbridge Helper Functions."""

    def __init__(self, db : database.Database, cit : citadel.Citadel):
        self.db = db
        self.cit = cit
        self.logger = logging.getLogger(__name__)
        pass

    def substitute_strings_in_embed(self, json: dict | list | str, substitutions: dict, depth : int = 0) -> dict | list | str:
        '''
        Recursively substitute strings in a json object

        Parameters
        -----------
        json: dict
            The json object to substitute strings in.
            Accepts list | str as well for recursion, caller should not pass these types.
        substitutions: dict
            The substitutions to make
        depth: int
            The depth of recursion. Used to prevent infinite recursion. Should not be used by the caller.

        Returns
        --------
        dict - The json object with the strings substituted.

        Raises
        -------
        ValueError - If the caller passes a list or str as the first argument.
        '''
        # Recursively substitute strings in a json object
        if depth > 5: # Prevent infinite recursion
            return json
        if depth == 0 and not isinstance(json, dict):
            raise ValueError(f'caller should pass a dict as the first argument, received {type(json)}')
        if isinstance(json, str): #  Self-referenced function to substitute strings in a json object
            for key, value in substitutions.items():
                json = json.replace(key, str(value))
            return json
        elif isinstance(json, dict):
            for key, value in json.items():
                json[key] = self.substitute_strings_in_embed(value, substitutions, depth=depth+1)
            return json
        elif isinstance(json, list):
            return [self.substitute_strings_in_embed(item, substitutions) for item in json]
        else:
            return json

    def generate_log(self, message : discord.Message, is_team : bool, match_id=0, log_type="CREATE", after : discord.Message=None):
        log = {}
        if is_team:
            team = database.get_team_by_channel_id(message.channel.id)
            if not team:
                return None
            log['match_id'] = 0
            log['team'] = team['team_id']
        else:
            if not match_id:
                return None
            match = self.db.get_match_details(match_id)
            teamsRoles = []
            teamsRoles.append(match['team_home'].role_id)
            teamsRoles.append(match['team_away'].role_id)
            log['match_id'] = match_id

            for teamRole in teamsRoles:
                if teamRole in message.author.roles:
                    log['team'] = database.get_team_id_of_role(teamRole)
                    break
            if 'team' not in log:
                log['team'] = None # Admin or Caster?
                #TODO: Handle Admins and Casters
        log['user_id'] = message.author.id
        log['user_name'] = message.author.name
        log['user_nick'] = message.author.nick
        log['user_avatar'] = message.author.display_avatar.url
        log['message_id'] = message.id
        log['message_content'] = message.content

        if message.attachments:
            log['message_additionals'] = ' '.join([attachment.url for attachment in message.attachments])
        else:
            log['message_additionals'] = ''
        log['log_type'] = log_type # CREATE / DELETE / EDIT
        log['log_timestamp'] = message.created_at
        if log_type == "EDIT":
            log['message_content'] = after.content
            log['log_timestamp'] = after.edited_at
        if log_type == "DELETE":
            log['log_timestamp'] = int(time.time())
        self.db.insert_log(log)
        self.logger.debug(f'new log {message.author.name}#{message.author.discriminator} ({message.author.id}) - {log_type}')

#del database, citadel, discord, logging, time
