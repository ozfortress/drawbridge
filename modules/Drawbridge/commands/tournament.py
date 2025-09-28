from ..checks import *
from ..functions import *
from ..logging import *
import discord
import os
import json
import random
import requests
from modules import database
from modules import citadel
from modules.logging_config import get_logger, log_command_execution
from typing import Optional
from discord import app_commands
from discord.ext import commands as discord_commands
from discord.ext import tasks as discord_tasks
import asyncio
import functools

__title__ = 'Tournament Commands'
__description__ = 'Commands for managing tournaments.'
__version__ = '0.0.1'

checks = Checks()

# Use centralized logging
logger = get_logger('drawbridge.tournament', 'tournament.log')

def log_command(func):
    """Decorator for logging tournament commands - uses centralized logging."""
    @functools.wraps(func)
    async def wrapper(self, interaction, *args, **kwargs):
        cmd_name = func.__name__
        logger.info(f"Command '{cmd_name}' executed by {interaction.user} (ID: {interaction.user.id}) with args: {args}, kwargs: {kwargs}")
        try:
            result = await func(self, interaction, *args, **kwargs)
            logger.info(f"Command '{cmd_name}' completed successfully")
            return result
        except Exception as e:
            logger.error(f"Command '{cmd_name}' failed: {e}", exc_info=True)
            raise
    return wrapper

@discord.app_commands.guild_only()
class Tournament(discord_commands.GroupCog, group_name='tournament', name='tournamnet', group_description='Commands for managing tournaments. This is a new string',):
    def __init__(self, bot:discord_commands.Bot, db:database.Database, cit:citadel.Citadel, main_logger) -> None:
        self.bot = bot
        self.cit = cit
        self.db = db
        self.logger = logger  # Use the centralized logger
        self.logger.info('Loaded Tournament Commands.')
        self.functions = Functions(self.db, self.cit)
        self.logging = Logging(self.bot, self.db, self.cit)
        self.perms_last_fixed = 0.0
        self.guild = self.bot.get_guild(int(os.getenv('DISCORD_GUILD_ID','')))
        
    @app_commands.command(
        name='launchpad'
    )
    @log_command
    @checks.has_roles(
        'DIRECTOR',
        'HEAD',
        'ADMIN',
        'TRIAL',
        'DEVELOPER',
        'BOT'
    )
    async def launchpad(self, interaction : discord.Interaction, share : bool=False):
        """Generate a launchpad message for all active tournaments"""
        await interaction.response.send_message('Generating launchpad...', ephemeral=not share)
        await self.update_launchpad()
        await interaction.edit_original_response(content='Launchpad generated and sent to the launchpad channel.')

    def better_lambda(self, div):
        priority_order = ['Premier', 'High', 'Intermediate', 'Main', 'Open']

        try:
            return priority_order.index(div['division_name'])
        except:
            return div['division_id']

    async def update_launchpad(self):
        # purge all messages in the launchpad channel
        # get the launchpad channel
        def is_me(m):
            return m.author == self.bot.user
        if self.guild is None:
            return
        channel = self.guild.get_channel(int(os.getenv('LAUNCH_PAD_CHANNEL','')))
        if type(channel) != discord.TextChannel:
            return
        async with channel.typing():
            await channel.purge(limit=100, check=is_me)
            teams = self.db.teams.get_all()
            matches = self.db.matches.get_unarchived()
            leagueids = []
            leagues=[]
            divids=[]
            divs=[]
            for team in teams:
                if team['league_id'] not in leagueids:
                    leagueids.append(team['league_id'])
                    leagues.append(self.cit.getLeague(team['league_id']))
                if team['division'] not in divids:
                    divids.append(team['division'])
                    divs.append(self.db.divisions.get_by_id(team['division']))
            if len(leagueids) == 0:
                await channel.send(content='There are no active tournaments running.')
                return

            rawlaunchpadmessage = ''
            # sort divs like this - Premier, High, Intermediate, Main, Open
            #priority_order = ['Premier', 'High', 'Intermediate', 'Main', 'Open']

            divs = sorted(divs, key=self.better_lambda)
            for leagues in leagues:
                rawlaunchpadmessage += f'# {leagues.name}\n'
                for div in divs:
                    if div['league_id'] == leagues.id: ## Does the league_id field match the league we're looking at?
                        rawlaunchpadmessage += f'## {div["division_name"]}\n'
                        rawlaunchpadmessage += f'### Teams\n'
                        for team in teams:
                            if (team['league_id'] == leagues.id) and (team['division'] == div['id']):
                                rawlaunchpadmessage += f'- {team["team_name"]} -> <#{team["team_channel"]}>\n'
                        rawlaunchpadmessage += f'### Matches\n'
                        for match in matches:
                            # self.logger.debug(f'Match league id {match["league_id"]} == {leagues.id} and match div id {match["division"]} == {div["id"]}')
                            if (int(match['league_id']) == int(leagues.id)) and (int(match['division']) == int(div['id'])):
                                # c = c+1
                                if match['channel_id'] == 0:
                                    rawlaunchpadmessage += f'- [{match["match_id"]}](<https://ozfortress.com/matches/{match["match_id"]}>) -> Bye\n'
                                else:
                                    rawlaunchpadmessage += f'- [{match["match_id"]}](<https://ozfortress.com/matches/{match["match_id"]}>) -> <#{match["channel_id"]}>\n'
                        if len(matches) == 0:
                            rawlaunchpadmessage += f'- No matches found\n'
                        rawlaunchpadmessage += '\n'
            launchpadmessages = []
            # split on the first \n under 2000 chars
            while len(rawlaunchpadmessage) > 2000:
                index = rawlaunchpadmessage[:2000].rfind('\n')
                launchpadmessages.append(rawlaunchpadmessage[:index])
                rawlaunchpadmessage = rawlaunchpadmessage[index:]
            launchpadmessages.append(rawlaunchpadmessage)
            for message in launchpadmessages:
                await channel.send(content=message)

    async def _assign_roles(self, league_id: int):
        # This needs a fair few requests to Citadel, unfortunately
        # AFAIK there’s no way to get whether a user is a captain from
        # the roster (which we already query)
        # So for each team we then have to query team
        not_in_server: list[str] = []
        not_linked: list[str] = []
        for div in self.db.divisions.get_by_league(league_id):
            div_role_id = div['role_id']
            div_role = self.guild.get_role(div_role_id)
            for team in self.db.teams.get_by_league(league_id):
                team_id = team['team_id']
                team_role_id = team['role_id']
                team_role = self.guild.get_role(team_role_id)
                team: citadel.Team = self.cit.getTeam(team_id)
                for user in team.players:
                    if user['is_captain']:
                        if self.db.synced_users.has_synced_citadel(user['id']):
                            synced_user = self.db.synced_users.get_by_citadel_id(user['id'])
                            if synced_user:
                                discord_id = synced_user['discord_id']
                            discord_user = self.bot.get_user(discord_id)
                            member: Optional[discord.Member] = self.guild.get_member(discord_id)
                            if member is not None:
                                await member.add_roles(div_role, reason="Drawbridge role assignment")
                                await member.add_roles(team_role, reason="Drawbridge role assignment")
                            elif not user['name'] in not_in_server:
                                not_in_server.append(user['name'])
                        elif not user['name'] in not_linked:
                            not_linked.append(user['name'])
            not_linked_str = f"## Account Not Linked\n{', '.join(not_linked)}\n" if len(not_linked) > 0 else ""
        not_in_server_str = f"## Not In Server\n{', '.join(not_in_server)}\n" if len(not_in_server) > 0 else ""
        return f"# Role Assignment Errors\n{not_linked_str}\n{not_in_server_str}"


    @app_commands.command(
        name='start'
    )
    @log_command
    @checks.has_roles(
        'DIRECTOR',
        'HEAD',
        'DEVELOPER',
    )
    async def start(self, interaction : discord.Interaction, league_id : int, league_shortcode: str, role_overrides: Optional[str], share : bool=False):
        """Generate team roles and channels for a given league. Assign all users with linked Citadel accounts roles.
        Parameters
        -----------
        league_id: int
            The League ID to generate teams for
        league_shortcode: str
            The Shortcode for this league (eg: HL 27, 6s 30 ), this will be appended to role names.
        role_overrides: Optional[str]
            Roles that should have access to generated team channels. These are comma-separated.
        """

        await interaction.response.send_message('Generating teams...', ephemeral=not share)
        league = self.cit.getLeague(league_id)
        rosters = league.rosters
        divs = []

        rawteammessage = ''
        with open('embeds/teams.json', 'r') as file:
            rawteammessage = file.read()

        for roster in rosters:
            if roster['division'] not in divs:
                divs.append(roster['division'])
            # trim team name to 20 char
            roster['role_name'] = f'{roster['name'][:20]} ({league_shortcode})'
            # role = await ctx.guild.create_role(name=role_name)
            # db.insert_team(roster)

        await interaction.edit_original_response(content=f'Generating Division Categories, Team Channels, and Roles.\nLeague: {league.name}\nDivisions: {len(divs)}\nTeams: {len(rosters)}\n\nIf we seem frozen, wait 5 minutes we might be rate limited.')
        r=0 #counters
        d=0 #counters
        for div in divs:
            d+=1
            overrides = {
                interaction.guild.default_role: discord.PermissionOverwrite(view_channel=False)
            }

            all_access = checks._get_role_ids('HEAD', 'ADMIN', '!AC', 'TRIAL', 'DEVELOPER', 'APPROVED', 'BOT')
            for role in all_access:
                overrides[interaction.guild.get_role(role)] = discord.PermissionOverwrite(view_channel=True, send_messages=True)
            additional_overrides = self.get_role_ids_from_overrides(role_overrides)
            for override in additional_overrides:
                overrides[override] = discord.PermissionOverwrite(view_channel=True, send_messages=True)

            channelcategory = await interaction.guild.create_category(f'{div} - {league_shortcode}', overwrites=overrides)

            role = await interaction.guild.create_role(name=f'{div} - {league_shortcode}')
            dbdiv = {
                'league_id': league_id,
                'division_name': div,
                'role_id': role.id,
                'category_id': channelcategory.id
            }
            i = 0
            divid = self.db.divisions.insert(dbdiv)
            for roster in rosters:
                if roster['division'] == div:
                    r+=1
                    if (len(roster['name']) > 50):
                        roster_name = f'{roster['name'][:47]}...'
                        role = await interaction.guild.create_role(name=f'{roster_name} ({league_shortcode})', mentionable=True)
                    else:
                        roster_name = roster['name']

                    role = await interaction.guild.create_role(name=f'{roster_name} ({league_shortcode})', mentionable=True)
                    overwrites = {
                        interaction.guild.default_role: discord.PermissionOverwrite(view_channel=False, send_messages=False),
                        role: discord.PermissionOverwrite(view_channel=True, send_messages=True)
                    }

                    all_access = checks._get_role_ids('HEAD', 'ADMIN', 'TRIAL', 'DEVELOPER', 'BOT')
                    for permrole in all_access:
                        overwrites[interaction.guild.get_role(permrole)] = discord.PermissionOverwrite(view_channel=True, send_messages=True)
                    for override in additional_overrides:
                        overwrites[override] = discord.PermissionOverwrite(view_channel=True, send_messages=True)
                    channel_name = f'🛡️{roster_name} ({league_shortcode})'
                    if len(channel_name) > 45:
                        channel_name = f'🛡️{roster_name[:20]} ({league_shortcode})'
                        self.logger.warning(f'Channel name for {roster_name} is too long, trimming to {channel_name}')
                    teamchannel = await interaction.guild.create_text_channel(channel_name, category=channelcategory, overwrites=overwrites)
                    team_id = roster['team_id']
                    subsitutions = {
                        '{TEAM_MENTION}': f'<@&{role.id}>',
                        '{TEAM_NAME}': roster_name,
                        '{TEAM_ID}': team_id,
                        '{DIVISION}': div,
                        '{LEAGUE_NAME}': league.name,
                        '{LEAGUE_SHORTCODE}': league_shortcode,
                        '{CHANNEL_ID}': str(teamchannel.id),
                        '{CHANNEL_LINK}': f'<#{teamchannel.id}>',
                    }
                    temprawteammessage = str(rawteammessage)
                    teammessage = json.loads(self.functions.substitute_strings_in_embed(temprawteammessage, subsitutions))
                    teammessage['embed'] = discord.Embed(**teammessage['embeds'][0])
                    del teammessage['embeds']
                    await teamchannel.send(**teammessage)
                    await interaction.edit_original_response(content=f'Generating Division Categories, Team Channels, and Roles.\nLeague: {league.name}\nDivisions: {d}/{len(divs)}\nTeams: {r}/{len(rosters)}\n\nLast Generated: {roster_name} ({league_shortcode})\n\nIf we seem frozen, wait 5 minutes we might be rate limited.')
                    dbteam = {
                        'roster_id': roster['id'],
                        'team_id': team_id,
                        'league_id': league_id,
                        'role_id': role.id,
                        'team_channel': teamchannel.id,
                        'division': divid,
                        'team_name': roster_name
                    }
                    self.db.teams.insert(dbteam)
        finished_response = '\n'.join([
            'Generated.'
            f'League: {league.name}',
            f'Divisions: {d}/{len(divs)}',
            f'{r}/{len(rosters)}',
            await self._assign_roles(league_id),
            'All done :3'
        ])
        await interaction.edit_original_response(content=finished_response)
        await self.update_launchpad()

    @app_commands.command(
        name='assign_roles'
    )
    @log_command
    @checks.has_roles(
        'DIRECTOR',
        'HEAD',
        'DEVELOPER',
    )
    async def assign_roles(self, interaction: discord.Interaction, league_id: int, show_missing: bool=False):
        """Assign all roles for a given league. This assumes that the league has been
        created via the start command.

        Parameters
        ----------
        league_id: int
            The League ID to assign roles for.
        show_missing: bool
            Whether to show the users who could not be assigned roles
        """
        failed_role_assignments = await self._assign_roles(league_id)
        if show_missing:
            await interaction.response.send_message(failed_role_assignments)
        else:
            await interaction.response.send_message("Added roles to all linked users", ephemeral=True)


    @app_commands.command(
        name='end'
    )
    @log_command
    @checks.has_roles(
        'DIRECTOR',
        'HEAD',
        'DEVELOPER',
    )
    @checks.has_been_warned(
        warned_for='end_tournament',
        warning_message='This command will archive all channels and roles for this tournament. Rerun the comamnd if you are prepared to proceed.'
    )
    async def end(self, interaction : discord.Interaction, league_id : int, share : bool=False):
        """End a tournament and archive all channels and roles

        Parameters
        -----------
        league_id: int
            The League ID to end the tournament for
        """

        await interaction.response.send_message('Ending tournament...', ephemeral=not share)

        divs = self.db.divisions.get_by_league(league_id)
        guild = interaction.guild
        teams = self.db.teams.get_by_league(league_id)
        # Get match channels by querying matches for the league
        league_matches = self.db.matches.get_by_league(league_id)
        match_channels = [{'channel_id': match['channel_id']} for match in league_matches if match['channel_id']]

        last_five = []
        def insert_to_lastfive(string: str):
            # add to the end, remove the first if there are more than 5
            last_five.append(string)
            if len(last_five) > 5:
                last_five.pop(0)
        self.logger.debug(f'Teams: {teams}')
        self.logger.debug(f'Match Channels: {match_channels}')
        self.logger.debug(f'Divisions: {divs}')
        status = "Deleting channels... (1/3)"
        await interaction.edit_original_response(content=f'{status}')

        for channel in guild.channels:
            for team in teams:
                if channel.id == team['team_channel']:
                    insert_to_lastfive(channel.name)
                    await channel.delete(
                        reason='Tournament ended'
                    )
                    await interaction.edit_original_response(content=f'{status}\n```\n{format(last_five)}\n```')
                    break
            for match_channel in match_channels:
                if channel.id == match_channel['channel_id']:
                    insert_to_lastfive(channel.name)
                    await channel.delete(
                        reason='Tournament ended'
                    )
                    await interaction.edit_original_response(content=f'{status}\n```\n{format(last_five)}\n```')

        last_five = []
        status = f'All Channels Deleted!\nDeleting categories... (2/3)'
        await interaction.edit_original_response(content=f'{status}')

        for div in divs:
            for category in guild.categories:
                if category.id == div['category_id']:
                    insert_to_lastfive(category.name)
                    await category.delete()
                    await interaction.edit_original_response(content=f'{status}\n```\n{format(last_five)}\n```')
                    break
        last_five = []
        status = f'All Channels Deleted!\nAll Categories Deleted!\nDeleting roles... (3/3)'
        await interaction.edit_original_response(content=f'{status}\n```')

        for role in guild.roles:
            for team in teams:
                if role.id == team['role_id']:
                    insert_to_lastfive(role.name)
                    await role.delete()
                    await interaction.edit_original_response(content=f'{status}\n```\n{format(last_five)}\n```')
                    break
        for div in divs:
            for role in guild.roles:
                if role.id == div['role_id']:
                    insert_to_lastfive(role.name)
                    await role.delete()
                    await interaction.edit_original_response(content=f'{status}\n```\n{format(last_five)}\n```')
                    break

        self.db.matches.delete_by_league(league_id)
        self.db.teams.delete_by_league(league_id)
        self.db.divisions.delete_by_league(league_id)


        await interaction.edit_original_response(content='Tournament ended. All channels, categories and roles have been archived.')
        await self.update_launchpad()

    async def _generate_match(self, match: Citadel.Citadel.Match, role_overrides: Optional[str] = None):
        """Generate a match channel for a given match

        Parameters
        -----------
        match: Citadel.Citadel.Match
            The match to generate a channel for
        role_overrides: Optional[str]
            Roles that should have access to generated match channels. These are comma-separated.

        Returns
        -----------
        bool
            True if the match was generated, False if the match was already generated

        Raises
        -----------
        Exception
            If the match could not be found or an error occurred
        """
        if self.db.matches.get_by_id(match.id) is not None:
            return False # It's already in the Database, must already be generated.
        if match.away_team is None:
            team_home = self.db.teams.get_by_team_and_league(match.home_team['team_id'], match.league_id)
            role_home = self.guild.get_role(team_home['role_id'])
            team_channel = self.bot.get_channel(team_home['channel_id'])
            await team_channel.send(f'Matches for round {match.round_number} were just generated. {role_home.mention} have a bye this round, and thus will be awarded a win.')
            self.db.insert_match({
                'match_id': match.id,
                'division': team_home['division_id'],
                'team_home': team_home['team_id'],
                'team_away': 0,
                'channel_id': 0, # 0 for bye,
                'league_id': match.league_id
            })
            self.db.archive_match(match.id)
            return True
        else:
            # Team roles
            team_home = self.db.teams.get_by_team_id(match.home_team['team_id'])
            team_away = self.db.teams.get_by_team_id(match.away_team['team_id'])

            if not team_home or not team_away:
                self.logger.error(f'Could not find team data for match {match.id}. Home: {team_home}, Away: {team_away}')
                return False

            # Category ID for the division
            divs = self.db.get_divs_by_league(match.league_id)
            if len(divs) == 0:
                raise Exception('No divisions found for the league for this match')
            category_id = 0
            for d in divs:
                if d['division_name'] == match.home_team['division']:
                    category_id = d['category_id']
                    break
            if category_id == 0:
                raise Exception('Division not found for the match')
            overrides = {
                self.guild.default_role: discord.PermissionOverwrite(view_channel=False, send_messages=False),
                self.guild.get_role(team_home['role_id']): discord.PermissionOverwrite(view_channel=True, send_messages=True),
                self.guild.get_role(team_away['role_id']): discord.PermissionOverwrite(view_channel=True, send_messages=True),
            }
            all_access = checks._get_role_ids('HEAD', 'ADMIN', 'TRIAL', 'DEVELOPER', 'APPROVED', 'BOT', 'STAFF')
            for role in all_access:
                overrides[self.guild.get_role(role)] = discord.PermissionOverwrite(view_channel=True, send_messages=True)
            for role in self.get_role_ids_from_overrides(role_overrides):
                overrides[role] = discord.PermissionOverwrite(view_channel=True, send_messages=True)
            cat = self.bot.get_guild(int(os.getenv('DISCORD_GUILD_ID'))).get_channel(category_id)
            if cat == None:
                raise Exception(f'Category not found for division {match.home_team["division"]}')
            if match.round_name == '':
                match.round_name = f'Round {match.round_number}'
            channel_name = f'🗡️-{match.id}-{team_home['team_name']}-vs-{team_away['team_name']}-{match.round_name}'
            trimmed = False
            if len(channel_name) > 100:
                trimmed_home_team = team_home['team_name'][:10]
                trimmed_away_team = team_away['team_name'][:10]
                channel_name = f'🗡️{match.id}-{trimmed_home_team}-vs-{trimmed_away_team}-{match.round_name}'
                self.logger.warning(f'Channel name too long when generating match {match.round_number} {team_home['team_name']} vs {team_away['team_name']}, trimming to {channel_name}')
            match_channel = await self.guild.create_text_channel(channel_name, category=cat, overwrites=overrides)
            # Load the message
            rawmatchmessage = ''
            with open('embeds/match.json', 'r') as file:
                rawmatchmessage = file.read()
            matchmessage = json.loads(self.functions.substitute_strings_in_embed(rawmatchmessage, {
                '{TEAM_HOME}': f'<@&{team_home['role_id']}>', # team role as a mention
                '{TEAM_AWAY}': f'<@&{team_away['role_id']}>', # team role as a mention
                '{ROUND_NAME}': match.round_name,
                '{MATCH_ID}': match.id,
                '{CHANNEL_ID}': str(match_channel.id),
                '{CHANNEL_LINK}': f'<#{match_channel.id}>'
            }))
            matchmessage['embed'] = discord.Embed(**matchmessage['embeds'][0])
            del matchmessage['embeds']
            await match_channel.send(**matchmessage)
            # Update the database
            self.db.insert_match({
                'match_id': match.id,
                'division': team_home['division'], # division
                'team_home': team_home['team_id'], # team_id
                'team_away': team_away['team_id'], # team_id
                'channel_id': match_channel.id,
                'league_id': match.league_id
            })
            # Lets also say something in their team channel
            try:
                team_home_channel = self.bot.get_channel(team_home['team_channel']) # team_channel
                team_away_channel = self.bot.get_channel(team_away['team_channel']) # team_channel
                await team_home_channel.send(f'Match for round {match.round_number} has been generated. Please head to {match_channel.mention} to organise your match.')
                await team_away_channel.send(f'Match for round {match.round_number} has been generated. Please head to {match_channel.mention} to organise your match.')
                if trimmed:
                    await team_home_channel.send(f'Heads up: Due to a discord limitation, we had to trim your match name down to {channel_name}. We apologise for any inconvenience.')
                    await team_away_channel.send(f'Heads up: Due to a discord limitation, we had to trim your match name down to {channel_name}. We apologise for any inconvenience.')
            except Exception as e:
                self.logger.error(f'Error sending message to team channels: {e}')
            return True

    @app_commands.command(
        name='matchgenround'
    )
    @log_command
    @checks.has_roles(
        'DIRECTOR',
        'HEAD',
        'DEVELOPER',
        'ADMIN',
        'TRIAL',
    )
    async def matchgenround(self, interaction : discord.Interaction, league_id : int, round_number : Optional[int], role_overrides : Optional[str]):
        """Generate ALL match channels for a given league (optionally limiting to a specific round). Attempts to skip matches already generated.

        Parameters
        -----------
        league_id: int
            The League ID to generate matches for
        round_number: Optional[int]
            The round number to generate matches for
        role_overrides: Optional[str]
            Roles that should have access to generated match/team channels. These are comma-separated.
        """
        await interaction.response.send_message('Finding matches...', ephemeral=True)
        try:
            # get the league
            league = self.cit.getLeague(league_id)
            matches = league.matches
            filtered_matches = []
            for match in matches:
                match2 = citadel.Citadel.PartialMatch(match)
                if match2.status == 'confirmed':
                    continue
                if round_number is not None and match2.round_number != round_number:
                    continue
                if self.db.matches.get_by_id(match2.id) is not None:
                    continue
                filtered_matches.append(match)
            if len(filtered_matches) == 0:
                await interaction.edit_original_response(content='No matches found - all are byes, already generated, or completed matches.')
                return
            c=0
            for match in filtered_matches:
                match2 = citadel.Citadel.PartialMatch(match)
                c=c+1
                await interaction.edit_original_response(content=f'Generating {c}/{len(filtered_matches)} matches...')
                fullmatch = self.cit.getMatch(match2.id)
                await self._generate_match(fullmatch, role_overrides)
            await interaction.edit_original_response(content='Matches generated.')
        except Exception as e:
            self.logger.error(f'Error generating matches: {e}', exc_info=True)
            await interaction.edit_original_response(content=f'An error occurred while generating matches.\n ```\n{e}\n```')

    @app_commands.command(
        name='matchgen'
    )
    @log_command
    @checks.has_roles(
        'DIRECTOR',
        'HEAD',
        'DEVELOPER',
        'ADMIN',
        'TRIAL',
    )
    async def matchgen(self, interaction : discord.Interaction, match_id : int, role_overrides : Optional[str]):
        """Generate match channels for a given match id

        Parameters
        -----------
        match_id: int
            ID of match to generate
        role_overrides: Optional[str]
            Roles that should have access to generated match channels. These are comma-separated.
        """

        await interaction.response.send_message('Generating matches...', ephemeral=True)
        try:
            match = self.cit.getMatch(match_id)
            if match is None:
                await interaction.edit_original_response(content='Match not found.')
                return
            await self._generate_match(match, role_overrides)
            await interaction.edit_original_response(content='Match generated.')
        except Exception as e:
            self.logger.error(f'Error generating match: {e}', exc_info=True)
            await interaction.edit_original_response(content=f'An error occurred while generating matches.\n ```\n{e}\n```')

    @app_commands.command(
        name='matchend'
    )
    @log_command
    @checks.has_roles(
        'DIRECTOR',
        'HEAD',
        'DEVELOPER',
        'ADMIN',
        'TRIAL',
    )
    async def matchend(self, interaction : discord.Interaction, match_id : int):
        """End a match and archive all channels

        Parameters
        -----------
        match_id: int
            Match ID to end
        """

        await interaction.response.send_message('Ending round...', ephemeral=True)

        match = self.db.get_match_by_id(match_id)
        if match is None:
            # await interaction.response.edit_message(content='Match not found.')
            await interaction.edit_original_response(content='Match not found in the database. Please ensure it has been generated first.')
            return
        if match['channel_id'] == 0:
            await interaction.edit_original_response(content='Match is a bye, cannot end. Please ensure the match has been generated first.')
            return
        if match['archived'] == 1:
            await interaction.edit_original_response(content='Match has already been archived. Please ensure the match has not already been ended.')
            return
        #match_channel = discord.Object(id=match['channel_id'])
        match_channel = interaction.guild.get_channel(match['channel_id'])
        if match_channel is None:
            await interaction.edit_original_response(content='Match channel not found. It may have already been deleted or never created.')
            self.logger.error(f'Match channel with ID {match['channel_id']} not found in guild.')
            self.db.archive_match(match_id)
            await self.update_launchpad()
            return
        await match_channel.send('Match has ended. This channel will now be archived.')
        # Make the channel read only
        overwrites = match_channel.overwrites
        for role,perm in overwrites.items():
            if role.id != interaction.guild.default_role.id:
                overwrites[role] = discord.PermissionOverwrite(read_messages=True, send_messages=False)

        await match_channel.edit(overwrites=overwrites)

        # Update the database
        self.db.archive_match(match_id)

        await interaction.edit_original_response(content='Round ended. All channels have been archived.')
        await self.update_launchpad()

    #Todo:
    #[x] Record all teams who succeed / fail a check
    #[x] Pull log to find active players
    #       - need to convert from steamid3 to steam64
    @app_commands.command(
            name='randomdemocheck',
            description='Initiates a random demo for a specific round. Optional: target specific player'
    )
    @log_command
    @checks.has_roles(
        'DIRECTOR',
        'HEAD',
        'DEVELOPER',
        'ADMIN',
        'TRIAL',
    )
    async def randomdemocheck(self, interaction : discord.Interaction, league_id : int, round_no : int = 0, spes_user: int = 0):
        """Conduct a random demo check.

        Parameters
        -----------
        league_id: int
            league to demo check

        round_no:
            the round that admins will check

        spes_user:
            target a specific player
        """
        await interaction.response.send_message('Democheck is in progress ...', ephemeral=True)
        try:
            league = self.cit.getLeague(league_id)

            player_chosen = None #player we're going to democheck
            match_chosen = None #The match they played on
            db_team = None #The database entry for the roster they're on

            init_size = 0
            if league is None:
                await interaction.edit_original_response(content='League not found. Aborting.')
                return
            if self.db.get_divs_by_league(league_id) is None:
                await interaction.edit_original_response(content='League not being monitored. Aborting.')
                return
            if spes_user == 0:
                # to make life easier we need to remove the description field of all matches

                # This method is a lot slower that my previous attempt but idgaf -ama
                matches = [self.cit.getMatch(mt['id']) for mt in league.matches]
                filtered_matches = []
                for m in matches:
                    if round_no > 0 and round_no != m.round_number:
                        continue
                    if m.forfeit_by != 'no_forfeit' or m.away_team is None:
                        continue
                    filtered_matches.append(m)

                if len(filtered_matches) == 0:
                    await interaction.edit_original_response(content=f'No matches were found for round {round_no}. Aborting.')
                    return

                random.shuffle(filtered_matches)
                part_match = filtered_matches[random.randint(0, len(filtered_matches)-1)] #partial match
                match_chosen = self.cit.getMatch(part_match['id'])
                self.logger.debug(f'Chosen match: {match_chosen}')

                if(random.randint(0, 1) == 0):
                    chosen_team = match_chosen.home_team
                else:
                    chosen_team = match_chosen.away_team

                pot_players = chosen_team['players']
                pl_id = pot_players[random.randint(0, len(pot_players)-1)]
                player_chosen = self.cit.getUser(pl_id['id'])
                db_team = self.db.teams.get_by_team_id(chosen_team['team_id'])
                if db_team is None:
                    await interaction.edit_original_response(content=f'DB_Team was not assigned. Chosen team id:{chosen_team["id"]}. DB call returned: {self.db.teams.get_by_team_id(chosen_team["id"])} Aborting.')
                    return
            else:
                player_chosen = self.cit.getUser(spes_user)
                if player_chosen is None:
                    await interaction.edit_original_response(content=f'Player could not be found with ID:{spes_user}. Aborting.')
                    return
                for roster in player_chosen.rosters:
                    db_team = self.db.teams.get_by_team_id(roster['team_id'])
                    if db_team is not None and db_team['league_id'] == league_id:
                        pl_roster = self.cit.getRoster(roster['id'])
                        break
                if db_team is None:
                    await interaction.edit_original_response(content=f'Player {player_chosen.name} couldn\'t be found on a roster for league ID: {league_id} Aborting.')
                    return
                matches = pl_roster.matches
                part_match = matches[random.randint(0, len(matches)-1)]
                match_chosen = self.cit.getMatch(part_match['id'])
            round = match_chosen.round_number
            messageraw = ''
            with open('embeds/democheck.json', 'r') as file:
                messageraw = file.read()
            tempmsg = str(messageraw)

            demochkmsg = json.loads(self.functions.substitute_strings_in_embed(tempmsg, {
                '{CHANNEL_ID}'  : f'<@&{db_team['role_id']}>', #These two may cause bugs depending on the data base
                '{TEAM_NAME}'   : f'{db_team['team_name']}',
                '{ROUND_NO}'    : f'{round}',
                '{TARGET_NAME}' : f'{player_chosen.name}',
                '{TARGET_ID}'   : f'{player_chosen.id}',
                '{MATCH_ID}'    : f'{match_chosen.id}'
            }))
            team_channel = self.bot.get_channel(db_team['team_channel'])
            if team_channel is None:
                await interaction.edit_original_response(content=f'Channel for team {db_team['team_name']} couldn\'t be found. Aborting.')
                return
            demochkmsg['embed'] = discord.Embed(**demochkmsg['embeds'][0])
            del demochkmsg['embeds']
            await team_channel.send(**demochkmsg)
            await interaction.edit_original_response(content=f'Random demo check announced. Player chosen is: {player_chosen['name']}')
        except Exception as e:
            self.logger.error(f'Error conducting demo check: {e}', exc_info=True)
            try:
                await interaction.edit_original_response(content=f'An error occurred while announcing the random demo check. Error: {e}.\n Line {e.__traceback__.tb_lineno}.')
            except Exception as e2:
                await interaction.edit_original_response(content=f'An error occurred while announcing the random demo check. Error: {e}.\n Line {e.__traceback__.tb_lineno}.\n Other exception: {e2}')

    ''' I'm saving this logic for later - Ama
                #This part can be removed to improve performance. Consult amatorii if you have questions
            get_log = True
            worked = 0
            if get_log:
                num = self.get_log_from_page(part_match['id'])
                if num is 'fuck':
                    get_log = False
                else:
                    players = self.get_log_JSON(num)
                    if players is 1:
                        get_log = False
                    else:
                        playerL = list(players['names'].keys())
                        random.shuffle(playerL)
                        for player in playerL:
                            player = player.replace("[","")
                            player = player.replace("]","")
                            if  in match_chosen.home_team:
                                t_player = player
                                break
            if not get_log:
    '''

    def get_log_JSON(self, url : str):
        response = requests.get(f'https://logs.tf/api/v1/log/{url}')
        if response is None:
            return 1
        return response.json()

    def get_log_from_page(self, num : str):
        match_page = requests.get(f'https://ozfortress.com/matches/{num}')
        page_list = match_page.text.splitlines()
        start_str = '<a href="https://logs.tf/'
        for l in page_list:
            l = l.strip()
            if l.__contains__('<a href="https://logs.tf/'):
                return l[l.find(start_str)+len(start_str):l.rfind('">')]
        return 'fuck'

    def get_role_ids_from_overrides(self, role_overrides: Optional[str]) -> list[discord.Role]:
        if role_overrides is not None:
            guild = self.bot.get_guild(int(os.getenv('DISCORD_GUILD_ID')))
            roles = []
            for role in role_overrides.split(','):
                role_obj = discord.utils.get(guild.roles, name=role.strip())
                if role_obj is not None:
                    roles.append(role_obj)
            return roles
        else:
            return []
    # @app_commands.command(
    #         name='randomdemocheck',
    #         description='Announces a truly random demo check, given a League ID. Automatically picks a team in the league, and a match to check'
    # )
    # @log_command
    # async def randomdemocheck(self, interaction : discord.Interaction, league_id : int, round_number : int=None):
    #     await interaction.response.send_message('Announcing random demo check...', ephemeral=True)
    #     try:
    #         league = self.cit.getLeague(league_id)
    #         if league is None:
    #             await interaction.edit_original_response(content='League not found. Aborting.', ephemeral=True)
    #             return
    #         # Confirm we are monitoring this league
    #         if self.db.get_divs_by_league(league_id) is None:
    #             await interaction.edit_original_response(content='League not being monitored. Aborting.', ephemeral=True)
    #             return
    #         # Get all teams in the league
    #         teams = self.db.get_teams_by_league(league_id)
    #         # Get all matches in the league
    #         matches = self.db.get_matches_by_league(league_id)

    #         # Pick a random team
    #         team = teams[random.randint(0, len(teams)-1)]
    #         # Pick a random match these guys played in
    #         match = None
    #         if round_number is not None:
    #             for m in matches:
    #                 if m[2] == team[0] and m[5] == round_number:
    #                     match = m
    #                     break
    #         else:
    #             while (match is None) or (match[3] != team[0] and match[2] != team[0]):
    #                 if match[3] != 0:
    #                     match = matches[random.randint(0, len(matches)-1)]
    #         cit_match = self.cit.getMatch(match[0])
    #         if cit_match is None:
    #             await interaction.edit_original_response(content='Match not found. Aborting.', ephemeral=True)
    #             return
    #         players = []
    #         if cit_match.home_team.id == team[0]:
    #             for player in cit_match.home_team.players:
    #                 players.append(player.name)
    #         elif cit_match.away_team.id == team[0]:
    #             for player in cit_match.away_team.players:
    #                 players.append(player.name)

    #         player = players[random.randint(0, len(players)-1)]
    #         # get a random player from citadel
    #         teamchannel = interaction.guild.get_channel(team[4])
    #         tempmsg = ''
    #         with open('embeds/democheck.json', 'r') as file:
    #             tempmsg = file.read()
    #         subs = {
    #             '{PLAYER}': player,
    #             '{MATCH_ID}': match[0],
    #             '{TEAM}': f'<@{team[2]}>'
    #         }
    #         msg = json.loads(self.functions.substitute_strings_in_embed(tempmsg, subs))
    #         msg['embed'] = discord.Embed(**msg['embeds'][0])
    #         del msg['embeds']
    #         await teamchannel.send(**msg)
    #         await interaction.edit_original_response(content='Random demo check announced.')
    #     except Exception as e:
    #         self.logger.error(f'Error announcing random demo check: {e}', exc_info=True)
    #         await interaction.edit_original_response(content='An error occurred while announcing the random demo check.')


    # @app_commands.command(
    #     name='democheck',
    #     description='Announces a random demo check for a given match. At this stage, a team id, a match ID and Player Name must be provided.'
    # )
    # @log_command
    # async def democheck(self, interaction : discord.Interaction, team_id: int, match_id : int, player_name : str):
    #     """Announces a demo check for a given match

    #     Parameters
    #     -----------
    #     match_id: int
    #         Match ID to check
    #     player_name: str
    #         Player name to check
    #     """

    #     await interaction.response.send_message('Announcing demo check...', ephemeral=True)
    #     try:
    #         match = self.db.get_match_by_id(match_id)
    #         team = self.db.get_team_by_id(team_id)
    #         if match is None:
    #             await interaction.edit_original_response(content='Match not found. Aborting.', ephemeral=True)
    #             return
    #         if team is None:
    #             await interaction.edit_original_response(content='Team not found. Aborting.', ephemeral=True)
    #             return
    #         if match[4] == 0:
    #             await interaction.edit_original_response(content='Match is a bye, cannot check. Aborting.', ephemeral=True)
    #             return
    #         if team[0] != match[2] and team[0] != match[3]:
    #             await interaction.edit_original_response(content='Team did not play in match. Aborting.', ephemeral=True)
    #             return

    #         teamchannel = interaction.guild.get_channel(team[4])
    #         tempmsg = ''
    #         with open('embeds/democheck.json', 'r') as file:
    #             tempmsg = file.read()
    #         subs = {
    #             '{PLAYER}': player_name,
    #             '{MATCH_ID}': match_id,
    #             '{TEAM}': f'<@{team[2]}>'
    #         }
    #         msg = json.loads(self.functions.substitute_strings_in_embed(tempmsg, subs))
    #         msg['embed'] = discord.Embed(**msg['embeds'][0])
    #         del msg['embeds']
    #         await teamchannel.send(**msg)
    #         await interaction.edit_original_response(content='Demo check announced.')
    #     except Exception as e:
    #         self.logger.error(f'Error announcing demo check: {e}', exc_info=True)
    #         await interaction.edit_original_response(content='An error occurred while announcing the demo check.')


    @app_commands.command(
        name='genlogs'
    )
    @log_command
    @checks.has_roles(
        'DEVELOPER',
        'HEAD',
        'ADMIN',
    )
    async def genlogs(self, interaction : discord.Interaction, match_id : int):
        """Generate logs for a match

        Parameters
        -----------
        match_id: int
            The Match ID to archive
        """
        
        await self.logging.archive_match(match_id=match_id,ctx=interaction)

    @app_commands.command(
        name='fixperms'
    )
    @log_command
    @checks.has_roles(
        'DEVELOPER',
    )
    @checks.has_been_warned(
        warned_for='fixperms',
        warning_message='This is a very expensive command to run. Only use this if you have 15-30 minutes to spare!'
    )
    async def fixperms(self, interaction : discord.Interaction):
        """Fix permissions for all channels and roles for a league"""
        # get all channels
        if (datetime.datetime.now().timestamp() - self.perms_last_fixed) < 900.0:
            await interaction.response.send_message('Permissions were fixed less than 15 minutes ago. Please wait before running this command again.', ephemeral=True)
            return
        self.perms_last_fixed = datetime.datetime.now().timestamp()
        guild = interaction.guild
        teams = self.db.get_all_teams()
        matches = self.db.get_all_matches()
        message_has_timed_out = False
        await interaction.response.send_message('Fixing permissions...', ephemeral=True)
        for channel in guild.channels:
            if isinstance(channel, discord.TextChannel):
                # check if its a team channel
                try:
                    if message_has_timed_out == False:
                        await interaction.edit_original_response(content=f'Fixing permissions for {channel.name}...')
                    else:
                        break
                except discord.errors.HTTPException as e:
                    # if 401 Unauthorized
                    if e.code == 401:
                        message_has_timed_out = True
                        await interaction.channel.send(content=f'Hey <@{interaction.user.id}>, Discord is giving us errors for editing the earlier interaction. We\'ll continue quietly in the background.')
                        break

                if channel.id in [team[5] for team in teams]:
                    team = [team for team in teams if team[5] == channel.id][0]
                    role = guild.get_role(team[3])
                    all_access = checks._get_role_ids('HEAD', 'ADMIN', 'TRIAL', '!AC', 'DEVELOPER', 'BOT')
                    no_access = checks._get_role_ids('CASTER')
                    await channel.set_permissions(role, read_messages=True, send_messages=True)
                    # wait one second
                    await asyncio.sleep(1)
                    # add admins
                    await channel.set_permissions(guild.default_role, read_messages=False)
                    await asyncio.sleep(1)
                    for role in all_access:
                        await channel.set_permissions(guild.get_role(role), read_messages=True, send_messages=True)
                        await asyncio.sleep(1)
                    for role in no_access:
                        await channel.set_permissions(guild.get_role(role), read_messages=False)
                        await asyncio.sleep(1)
                # check if its a match channel
                if channel.id in [match['channel_id'] for match in matches if match['channel_id']]:
                    match = [match for match in matches if match.get('channel_id') == channel.id][0]
                    all_access = checks._get_role_ids('HEAD', 'ADMIN', 'TRIAL', 'DEVELOPER', 'APPROVED', 'BOT')
                    no_access = checks._get_role_ids('UNAPPROVED')
                    await channel.set_permissions(guild.default_role, read_messages=False)
                    await asyncio.sleep(1)
                    team_home = self.db.teams.get_by_team_id(match['team_home'])
                    team_away = self.db.teams.get_by_team_id(match['team_away'])
                    if team_home:
                        await channel.set_permissions(guild.get_role(team_home['role_id']), read_messages=True, send_messages=True)
                        await asyncio.sleep(1)
                    if team_away:
                        await channel.set_permissions(guild.get_role(team_away['role_id']), read_messages=True, send_messages=True)
                        await asyncio.sleep(1)
                    for role in all_access:
                        await channel.set_permissions(guild.get_role(role), read_messages=True, send_messages=True)
                        await asyncio.sleep(1)
                    for role in no_access:
                        await channel.set_permissions(guild.get_role(role), read_messages=False)
                        await asyncio.sleep(1)
        try:
            await interaction.edit_original_response(content='Permissions fixed.')
        except discord.errors.HTTPException as e:
            if e.code == 401:
                await interaction.channel.send(content='Permissions fixed.')




    # @tournament.error
    # async def tournament_error(self, ctx : discord.Interaction, error):
    #     if isinstance(error, discord_commands.errors.MissingPermissions):
    #         await ctx.response.send_message(content='You do not have permission to run this command.', ephermeral=True)
    #     else:
    #         await ctx.response.send_message(content='An error occurred while running this command.', ephermeral=True)


async def initialize(bot: discord_commands.Bot, db, cit, logger):
    tournament = Tournament(bot, db, cit, logger)
    await bot.add_cog(tournament, guilds=[bot.get_guild(int(os.getenv('DISCORD_GUILD_ID')))])
    await tournament.update_launchpad() # on startup
    # list = await bot.tree.sync(guild=discord.Object(id=os.getenv('DISCORD_GUILD_ID')))
    # logger.info(f'Loaded Tournament Commands: {list}')


#del discord, os, json, database, citadel, discord_commands
