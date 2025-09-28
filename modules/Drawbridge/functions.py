import modules.database as database
import modules.citadel as citadel
import discord
import logging
import datetime

__version__ = "1.0.0"

class Functions:
    """
    Drawbridge Helper Functions."""

    def __init__(self, db : database.Database, cit : citadel.Citadel):
        self.db = db
        self.cit = cit
        self.logger = logging.getLogger(__name__)
        pass

    def substitute_strings_in_embed(self, json: str, substitutions: dict) -> str:
        for k,v in substitutions.items():
            json = json.replace(k, str(v))
        return json

    def generate_log(self, message : discord.Message, is_team : bool, match_id, team_id, log_type="CREATE", after : discord.Message=None):
        log = {}
        if is_team:
            log['team_id'] = team_id
            log['match_id'] = None
        else:
            match = self.db.get_match_details(match_id)
            teamsRoles = []
            teamsRoles.append(match['team_home'])
            teamsRoles.append(match['team_away'])
            log['match_id'] = match_id
            log['team_id'] = None

        log['user_id'] = message.author.id
        log['user_name'] = message.author.name
        log['user_nick'] = getattr(message.author, 'nick', message.author.name)
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
            log['log_timestamp'] = datetime.datetime.now()
        self.db.logs.insert(log)
        #self.logger.debug(f'new log {message.author.name}#{message.author.discriminator} ({message.author.id}) - {log_type}')
