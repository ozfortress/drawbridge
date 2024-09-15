import modules.database as database
import modules.citadel as citadel
import os
import discord
import json
import logging
from . import functions as Drawbridge
from discord.ext import commands as discord_commands

class Guardrail:
    """
    Drawbridge's Guard Rail module.
    Protects against accidentally or maliciously deleting channels or roles"""
    def __init__(self, db : database.Database, cit : citadel.Citadel):
        self.db = db
        self.cit = cit
        self.logger = logging.getLogger(__name__)
        self.functions = Drawbridge.Functions(db, cit)
        pass

    @discord_commands.Cog.listener()
    async def on_guild_channel_delete(self, channel : discord.TextChannel):
        """
        Check if a channel that was deleted was a channel we care about.
        If it was, log it, recreate it, and make the neccisary changes to the database.
        """
        if channel.guild.id != int(os.getenv('DISCORD_GUILD_ID')):
            return
        if self.db.is_a_team_channel(channel.id):
            self.logger.info(f'Channel {channel.name} ({channel.id}) was deleted. Recreating it.')
            # Someone gets their fingers broken.
            team = self.db.get_team_by_channel_id(channel.id)
            division = self.db.get_div_by_id(team[5])
            category_id = division[4]
            guild = channel.guild
            category = guild.get_channel(category_id)
            league = self.db.get_league_info(division[2])
            new_channel = await category.create_text_channel(name=f'{channel.name}', overwrites=channel.overwrites, category=category)
            rawteammessage = ''
            with open('embeds/teams.json', 'r') as file:
                rawteammessage = file.read()
            substitutions = {
                '{TEAM_MENTION}': f'<@&{team[2]}>',
                '{TEAM_NAME}': team[3],
                '{TEAM_ID}': team[0],
                '{DIVISION}': division[1],
                '{LEAGUE_NAME}': league[1],
                '{LEAGUE_SHORTCODE}': league[2],
                '{CHANNEL_ID}': str(new_channel.id),
                '{CHANNEL_LINK}': f'<#{new_channel.id}>',
            }
            teammessage = json.loads(self.functions.substitute_strings_in_embed(rawteammessage, substitutions))
            teammessage['embed'] = discord.Embed(**teammessage['embeds'][0])
            del teammessage['embeds']
            await new_channel.send(**teammessage)
            await new_channel.send(f'@here - This channel was accidentally deleted. Due to limitations, we cannot restore the original comms, however the original comms are available to your division admins.')
            self.db.update_team_channel(team[0], new_channel.id)
        if self.db.is_a_match_channel(channel.id):
            self.logger.info(f'Channel {channel.name} ({channel.id}) was deleted. Recreating it.')
            match = self.db.get_match_by_channel_id(channel.id)
            division = self.db.get_div_by_id(match[1])
            home_team = self.db.get_team_by_id(match[2])
            away_team = self.db.get_team_by_id(match[3])

            # create new channel
            category = channel.category
            new_channel = await category.create_text_channel(name=f'{channel.name}', overwrites=channel.overwrites, category=category)
            rawmatchmessage = ''
            with open('embeds/match.json', 'r') as file:
                rawmatchmessage = file.read()
            tempmatchmessage = str(rawmatchmessage)
            citmatchinfo = self.cit.getMatch(match[0])
            if citmatchinfo.round_name == '':
                citmatchinfo.round_name = f'Round {citmatchinfo.round_number}'
            substitutions = {
                '{TEAM_HOME}': f'<@&{home_team[2]}>', # team role as a mention
                '{TEAM_AWAY}': f'<@&{away_team[2]}>', # team role as a mention
                '{ROUND_NAME}': citmatchinfo.round_name,
                '{MATCH_ID}': match[0],
                '{CHANNEL_ID}': str(new_channel.id),
                '{CHANNEL_LINK}': f'<#{new_channel.id}>'
            }
            matchmessage = json.loads(self.functions.substitute_strings_in_embed(tempmatchmessage, substitutions))
            matchmessage['embed'] = discord.Embed(**matchmessage['embeds'][0])
            del matchmessage['embeds']
            await new_channel.send(**matchmessage)
            await new_channel.send(f'@here - This channel was accidentally deleted. Due to limitations, we cannot restore the match comms, however the original comms are available to your division admins. Please reaffirm details such as mercs and scheduling here.')
            self.db.update_match_channel(match[0], new_channel.id)
            # update the support channel
            home_team_channel = channel.guild.get_channel(home_team[4])
            away_team_channel = channel.guild.get_channel(away_team[4])
            home_team_ping = f'<@&{home_team[2]}>'
            away_team_ping = f'<@&{away_team[2]}>'
            msg = f'Apologies, your match channel for {citmatchinfo.round_name} was erroneously delted. It has been recreated at {new_channel.mention}. Please go there to reconfirm match details.'
            await home_team_channel.send(f'{home_team_ping} {msg}')
            await away_team_channel.send(f'{away_team_ping} {msg}')
