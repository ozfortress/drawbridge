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
        from modules.Drawbridge.checks import Checks
        self.checks = Checks()
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
        log['channel_id'] = message.channel.id

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

        if isinstance(message.author, discord.Member):
            author_roles = {r.id for r in message.author.roles}
            role_sets = {}
            try:
                role_sets = {
                    'DIRECTOR': set(self.checks._get_role_ids('DIRECTOR')),
                    'HEAD': set(self.checks._get_role_ids('HEAD')),
                    'ADMIN': set(self.checks._get_role_ids('ADMIN', 'TRIAL', '!HEAD')),
                    'STAFF': set(self.checks._get_role_ids('DEVELOPER', 'APPROVED', 'STAFF', '!UNAPPROVED')),
                    'CASTER': set(self.checks._get_role_ids('CASTER')),
                }
            except Exception:
                pass

            # Priority order: team > director > head_admin > admin > staff > caster
            if not is_team and match:
                home_team = self.db.teams.get_by_team_id(match['team_home'])
                away_team = self.db.teams.get_by_team_id(match['team_away'])
                if home_team and author_roles & {home_team.get('role_id', 0)}:
                    log['role_type'] = 'player_home'
                elif away_team and author_roles & {away_team.get('role_id', 0)}:
                    log['role_type'] = 'player_away'
                elif role_sets.get('DIRECTOR') and author_roles & role_sets['DIRECTOR']:
                    log['role_type'] = 'director'
                elif role_sets.get('HEAD') and author_roles & role_sets['HEAD']:
                    log['role_type'] = 'head_admin'
                elif role_sets.get('ADMIN') and author_roles & role_sets['ADMIN']:
                    log['role_type'] = 'admin'
                elif role_sets.get('STAFF') and author_roles & role_sets['STAFF']:
                    log['role_type'] = 'staff'
                elif role_sets.get('CASTER') and author_roles & role_sets['CASTER']:
                    log['role_type'] = 'caster'
                else:
                    log['role_type'] = 'unknown'
            else:
                # Team channel or no match context
                if role_sets.get('DIRECTOR') and author_roles & role_sets['DIRECTOR']:
                    log['role_type'] = 'director'
                elif role_sets.get('HEAD') and author_roles & role_sets['HEAD']:
                    log['role_type'] = 'head_admin'
                elif role_sets.get('ADMIN') and author_roles & role_sets['ADMIN']:
                    log['role_type'] = 'admin'
                elif role_sets.get('STAFF') and author_roles & role_sets['STAFF']:
                    log['role_type'] = 'staff'
                elif role_sets.get('CASTER') and author_roles & role_sets['CASTER']:
                    log['role_type'] = 'caster'
                else:
                    log['role_type'] = 'unknown'
        else:
            log['role_type'] = 'unknown'

        self.db.logs.insert(log)
        #self.logger.debug(f'new log {message.author.name}#{message.author.discriminator} ({message.author.id}) - {log_type}')
