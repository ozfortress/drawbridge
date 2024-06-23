from ..checks import *
from ..functions import *
from ..logging import *
import discord
import os
import json
from modules import database
from modules import citadel

from discord import app_commands
from discord.ext import commands as discord_commands
from discord.ext import tasks as discord_tasks

__title__ = 'Tournament Commands'
__description__ = 'Commands for managing tournaments.'
__version__ = '0.0.1'


@Checks.heads_only(Checks)
@discord.app_commands.guild_only()
class Tournament(discord_commands.GroupCog, group_name='tournament', name='tournamnet', group_description='Commands for managing tournaments. This is a new string',):
    def __init__(self, bot:discord_commands.Bot, db, cit, logger) -> None:
        self.bot = bot
        self.cit = cit
        self.db = db
        self.logger = logger
        self.logger.info('Loaded Tournament Commands.')
        self.functions = Functions(self.db, self.cit)

    # tournament = discord.app_commands.Group(name='tournament', description='Commands for managing ozfortress tournaments, including generating match channels and starting/ending tournaments', guild_only=True, guild_ids=[os.getenv('DISCORD_GUILD_ID')])

        # @Checks.heads_only(Checks)

        # @command_tree.(
        #     name='tournament',
        #     guild=discord.Object(id=os.getenv('DISCORD_GUILD_ID'))
        # )
        # async def tournament(interaction : discord.Interaction):
        #     """Base command for tournament management"""
        #     await interaction.response.send_message('Please specify a subcommand.', ephemeral=True)



    # @Checks.heads_only(Checks)
    # @client.command(
    #     name='start',
    #     # guild=discord.Object(id=os.getenv('DISCORD_GUILD_ID'))
    # )

    @app_commands.command(
        name='test'
    )
    async def test(self, interaction : discord.Interaction):
        await interaction.response.send_message('Test command.', ephemeral=True)

    @app_commands.command(
        name='start'
    )
    async def start(self, interaction : discord.Interaction, league_id : int, league_shortcode: str):
        """Generate team roles and channels for a given league

        Parameters
        -----------
        league_id: int
            The League ID to generate teams for
        league_shortcode: str
            The Shortcode for this league (eg: HL 27, 6s 30 ), this will be appended to role names.
        """

        await interaction.response.send_message('Generating teams...', ephemeral=True)
        league = self.cit.getLeague(league_id)
        is_hl = 'highlander' in league.name.lower()
        rosters = league.rosters
        divs = []

        rawteammessage = json.load(open('embeds/teams.json', 'r'))
        for roster in rosters:
            if roster['division'] not in divs:
                divs.append(roster['division'])
            # trim team name to 20 char
            roster['role_name'] = f'{roster['name'][:20]} ({league_shortcode})'
            # role = await ctx.guild.create_role(name=role_name)
            # db.insert_team(roster)

        await interaction.edit_original_response(content=f'Generating Division Categories, Team Channels, and Roles.\nLeague: {league.name}\nDivisions: {len(divs)}\nTeams: {len(rosters)}')
        r=0 #counters
        d=0 #counters
        for div in divs:
            d+=1
            catoverwrites = {
                interaction.guild.default_role: discord.PermissionOverwrite(read_messages=False),
                # discord.Object(id=(is_hl == True ? roles['HL Admin'] : roles['6s Admin'])) : discord.PermissionOverwrite(read_messages=True),
                discord.Object(id=Checks.roles['6s Head']) : discord.PermissionOverwrite(read_messages=True),
                discord.Object(id=Checks.roles['HL Head']) : discord.PermissionOverwrite(read_messages=True),
                discord.Object(id=Checks.roles['Trial Admin']) : discord.PermissionOverwrite(read_messages=True), # Or false? dunno hey.
                discord.Object(id=Checks.roles['Developers']) : discord.PermissionOverwrite(read_messages=True),
                discord.Object(id=Checks.roles['Approved Casters']) : discord.PermissionOverwrite(read_messages=False),
                discord.Object(id=Checks.roles['Unapproved Casters']) : discord.PermissionOverwrite(read_messages=False),
                discord.Object(id=Checks.roles['Captains Bot']) : discord.PermissionOverwrite(read_messages=True)
            }
            if is_hl:
                catoverwrites[discord.Object(id=Checks.roles['HL Admin'])] = discord.PermissionOverwrite(read_messages=True)
            else:
                catoverwrites[discord.Object(id=Checks.roles['6s Admin'])] = discord.PermissionOverwrite(read_messages=True)

            channelcategory = await interaction.guild.create_category(f'{div} - {league_shortcode}')

            role = await interaction.guild.create_role(name=f'{div} - {league_shortcode}')
            dbdiv = {
                'league_id': league_id,
                'division_name': div,
                'role_id': role.id,
                'category_id': channelcategory.id
            }
            divid = self.db.insert_div(dbdiv)
            for roster in rosters:
                if roster['division'] == div:
                    r+=1
                    role = await interaction.guild.create_role(name=f'{roster['name']} ({league_shortcode})', mentionable=True)
                    overwrites = {
                        role: discord.PermissionOverwrite(read_messages=True),
                    }
                    teamchannel = await interaction.guild.create_text_channel(f'{roster['name']} ({league_shortcode})', category=channelcategory, overwrites=overwrites)
                    team_id = roster['team_id']

                    # Load the chat message from embeds/teams.json

                    subsitutions = {
                        '{TEAM_MENTION}': f'<@&{role.id}>',
                        '{TEAM_NAME}': roster['name'],
                        '{TEAM_ID}': team_id,
                        '{DIVISION}': div,
                        '{LEAGUE_NAME}': league.name,
                        '{LEAGUE_SHORTCODE}': league_shortcode,
                        '{CHANNEL_ID}': str(teamchannel.id),
                        '{CHANNEL_LINK}': f'<#{teamchannel.id}>',
                    }
                    temprawteammessage = dict(rawteammessage)
                    teammessage = self.functions.substitute_strings_in_embed(temprawteammessage, subsitutions)
                    teammessage['embed'] = discord.Embed(**teammessage['embeds'][0])
                    del teammessage['embeds']
                    await teamchannel.send(**teammessage)
                    await interaction.edit_original_response(content=f'Generating Division Categories, Team Channels, and Roles.\nLeague: {league.name}\nDivisions: {d}/{len(divs)}\nTeams: {r}/{len(rosters)}')
                    dbteam = {
                        'team_id': team_id,
                        'league_id': league_id,
                        'role_id': role.id,
                        'team_channel': teamchannel.id,
                        'division': divid,
                        'team_name': roster['name']
                    }
                    self.db.insert_team(dbteam)
        await interaction.edit_original_response(content=f'Generated.\nLeague: {league.name}\nDivisions: {d}/{len(divs)}\nTeams: {r}/{len(rosters)}')

    @app_commands.command(
        name='end'
    )
    async def end(self, interaction : discord.Interaction, league_id : int):
        """End a tournament and archive all channels and roles

        Parameters
        -----------
        league_id: int
            The League ID to end the tournament for
        """

        await interaction.response.send_message('Ending tournament...', ephemeral=True)

        divs = self.db.get_divs_by_league(league_id)
        guild = interaction.guild
        teams = self.db.get_teams_by_league(league_id)
        match_channels = self.db.get_match_channels_by_league(league_id)

        for channel in guild.channels:
            for team in teams:
                if channel.id == team[4]:
                    await channel.delete()
                    break
            for match_channel in match_channels:
                if channel.id == match_channel[0]:
                    await channel.delete()

        for role in guild.roles:
            for team in teams:
                if role.id == team[2]:
                    await role.delete()
                    break

        for div in divs:
            for category in guild.categories:
                if category.id == div[4]:
                    await category.delete()
                    break
            for role in guild.roles:
                if role.id == div[3]:
                    await role.delete()
                    break

        self.db.delete_teams_by_league(league_id)
        self.db.delete_divisions_by_league(league_id)
        self.db.delete_matches_by_league(league_id)

        await interaction.edit_original_response(content='Tournament ended. All channels and roles have been archived.')

    # @app_commands.command(
    #     name='roundgen'
    # )
    # async def roundgen(self, interaction : discord.Interaction, league_id : int, round_number : int = None):
    #     """Generate match channels for a given round of a league

    #     Parameters
    #     -----------
    #     league_id: int
    #         The League ID to generate matches for
    #     round_number: int (optional)
    #         The round number to generate matches for. If not provided, will generate all matches to date.
    #     """
    #     await interaction.response.send_message('Generating matches...', ephemeral=True)
    #     league = self.cit.getLeague(league_id)
    #     # loop through league.matches and generate channels for each match, provided they are in the correct round
    #     for match in league.matches:
    #         if round_number is None or match['round_number'] == round_number:
    #             # generate match channels
    #             round = self.cit.getMatch(match['id'])
    #             # Did we already generate this match?
    #             if self.db.get_match_by_id(match['id']) is not None:
    #                 # We already generated this match, skip it.
    #                 continue
    #             # Is this a bye?
    #             elif round.away_team is None:
    #                 # This is a bye, we don't need to generate a channel for this.
    #                 team_home = self.db.get_team_by_id(round['home_team'])
    #                 role_home = discord.Object(id=team_home['role_id'])
    #                 team_channel = discord.Object(id=team_home['team_channel'])
    #                 await team_channel.send(f'Matches for round {match['round_number']} were just generated. {role_home.mention} have a bye this round, and thus will be awarded a win.') #TODO - JSON embed for this
    #                 self.db.insert_match({
    #                     'match_id': match['id'],
    #                     'division': team_home['division'],
    #                     'team_home': team_home['team_id'],
    #                     'team_away': 0,
    #                     'channel_id': 0 # 0 for bye
    #                 })
    #             else:
    #                 # We now know who the two teams are, lets get their roles
    #                 #print(str(round.home_team))
    #                 #print(str(round.away_team))
    #                 #print(str(round.home_team['team_id']))
    #                 #print(str(round.away_team['team_id']))
    #                 team_home = self.db.get_team_by_id(round.home_team['team_id'])
    #                 team_away = self.db.get_team_by_id(round.away_team['team_id'])
    #                 # Team roles
    #                 role_home = discord.Object(id=team_home[2]) # role_id is 2
    #                 role_away = discord.Object(id=team_away[2])
    #                 # Category ID for the division
    #                 category_id = self.db.get_div_by_name(round.home_team['division'])[4] # always pull from home team, 4 is category_id btw
                    
    #                 overrides = {
    #                     interaction.guild.default_role: discord.PermissionOverwrite(read_messages=False),
    #                     interaction.guild.get_role(team_home[2]): discord.PermissionOverwrite(read_messages=True),
    #                     interaction.guild.get_role(team_away[2]): discord.PermissionOverwrite(read_messages=True),
    #                     interaction.guild.get_role(int(Checks.roles['6s Head'])): discord.PermissionOverwrite(read_messages=True),
    #                     interaction.guild.get_role(int(Checks.roles['HL Head'])): discord.PermissionOverwrite(read_messages=True),
    #                     interaction.guild.get_role(int(Checks.roles['Trial Admin'])): discord.PermissionOverwrite(read_messages=True),
    #                     interaction.guild.get_role(int(Checks.roles['Developers'])): discord.PermissionOverwrite(read_messages=True),
    #                     interaction.guild.get_role(int(Checks.roles['Approved Casters'])): discord.PermissionOverwrite(read_messages=True),
    #                     interaction.guild.get_role(int(Checks.roles['Unapproved Casters'])): discord.PermissionOverwrite(read_messages=True),
    #                     interaction.guild.get_role(int(Checks.roles['Captains Bot'])): discord.PermissionOverwrite(read_messages=True),
    #                     interaction.guild.get_role(int(Checks.roles['HL Admin'])): discord.PermissionOverwrite(read_messages=True),
    #                     interaction.guild.get_role(int(Checks.roles['6s Admin'])): discord.PermissionOverwrite(read_messages=True)
    #                 }
    #                 for key in overrides:
    #                     print(key)
    #                 match_channel = await interaction.guild.create_text_channel(f'{team_home[3]}-⚔️-{team_away[3]}-Round-{match['round_number']}-{match['id']}', category=discord.Object(id=category_id), overwrites=overrides)
    #                 #match_channel = await interaction.guild.create_text_channel(f'{team_home[3]}-⚔️-{team_away[3]}-Round-{match['round_number']}-{match['id']}', category=discord.Object(id=category_id))
    #                 # Load the chat message from embeds/match.json
    #                 match_message = json.load(open('embeds/match.json', 'r'))
    #                 if match['round_name'] == '':
    #                     match['round_name'] = f'Round {match['round_number']}'
    #                 match_message = self.functions.substitute_strings_in_embed(match_message, {
    #                     '{TEAM_HOME}': team_home[3], # team_name
    #                     '{TEAM_AWAY}': team_away[3], # team_name
    #                     '{ROUND_NAME}': match['round_name'],
    #                     '{MATCH_ID}': match['id'],
    #                     '{CHANNEL_ID}': str(match_channel.id),
    #                     '{CHANNEL_LINK}': f'<#{match_channel.id}>'
    #                 })
    #                 match_message['embed'] = discord.Embed(**match_message['embeds'][0])
    #                 del match_message['embeds']
    #                 await match_channel.send(**match_message)
    #                 # Update the database
    #                 self.db.insert_match({
    #                     'match_id': match['id'],
    #                     'division': team_home[5], # division
    #                     'team_home': team_home[0], # team_id
    #                     'team_away': team_away[0], # team_id
    #                     'channel_id': match_channel.id
    #                 })
    #     #await interaction.response.edit_message(content='Matches generated.', ephemeral=True)
    #     await interaction.edit_original_response(content='Matches generated.')

    @app_commands.command(
        name='roundgen'
    )
    async def roundgen(self, interaction : discord.Interaction, match_id : int):
        """Generate match channels for a given round of a league

        Parameters
        -----------
        match_id: int (optional)
            ID of match to generate
        """

        await interaction.response.send_message('Generating matches...', ephemeral=True)
        match = self.cit.getMatch(match_id)
        
        if self.db.get_match_by_id(match_id) is not None:
            await interaction.edit_original_response(content='This match has already been generated.')
            return
        
        if match.away_team is None:
            # This is a bye, we don't need to generate a channel for this.
            team_home = self.db.get_team_by_id(match['home_team'])
            role_home = discord.Object(id=team_home['role_id'])
            team_channel = discord.Object(id=team_home['team_channel'])
            await team_channel.send(f'Matches for round {match['round_number']} were just generated. {role_home.mention} have a bye this round, and thus will be awarded a win.') #TODO - JSON embed for this
            self.db.insert_match({
                'match_id': match['id'],
                'division': team_home['division'],
                'team_home': team_home['team_id'],
                'team_away': 0,
                'channel_id': 0, # 0 for bye,
                'league_id': match.league_id
            })
        else:
            team_home = self.db.get_team_by_id(match.home_team['team_id'])
            team_away = self.db.get_team_by_id(match.away_team['team_id'])
            # Team roles
            #role_home = discord.Object(id=team_home[2]) # role_id is 2
            #role_away = discord.Object(id=team_away[2])
            # Category ID for the division
            category_id = self.db.get_div_by_name(match.home_team['division'])[4] # always pull from home team, 4 is category_id btw
            
            overrides = {
                interaction.guild.default_role: discord.PermissionOverwrite(read_messages=False),
                interaction.guild.get_role(team_home[2]): discord.PermissionOverwrite(read_messages=True),
                interaction.guild.get_role(team_away[2]): discord.PermissionOverwrite(read_messages=True),
                interaction.guild.get_role(Checks.roles['6s Head']): discord.PermissionOverwrite(read_messages=True),
                interaction.guild.get_role(Checks.roles['HL Head']): discord.PermissionOverwrite(read_messages=True),
                interaction.guild.get_role(Checks.roles['Trial Admin']): discord.PermissionOverwrite(read_messages=True),
                interaction.guild.get_role(Checks.roles['Developers']): discord.PermissionOverwrite(read_messages=True),
                interaction.guild.get_role(Checks.roles['Approved Casters']): discord.PermissionOverwrite(read_messages=True),
                interaction.guild.get_role(Checks.roles['Unapproved Casters']): discord.PermissionOverwrite(read_messages=True),
                interaction.guild.get_role(Checks.roles['Captains Bot']): discord.PermissionOverwrite(read_messages=True),
                interaction.guild.get_role(Checks.roles['HL Admin']): discord.PermissionOverwrite(read_messages=True),
                interaction.guild.get_role(Checks.roles['6s Admin']): discord.PermissionOverwrite(read_messages=True)
            }
            #for key in overrides:
                #print(key)
            match_channel = await interaction.guild.create_text_channel(f'{team_home[3]}-⚔️-{team_away[3]}-Round-{match.round_number}-{match_id}', category=discord.Object(id=category_id), overwrites=overrides)
            #match_channel = await interaction.guild.create_text_channel(f'{team_home[3]}-⚔️-{team_away[3]}-Round-{match['round_number']}-{match['id']}', category=discord.Object(id=category_id))
            # Load the chat message from embeds/match.json
            match_message = json.load(open('embeds/match.json', 'r'))
            if match.round_name == '':
                match.round_name = f'Round {match.round_number}'
            match_message = self.functions.substitute_strings_in_embed(match_message, {
                '{TEAM_HOME}': team_home[3], # team_name
                '{TEAM_AWAY}': team_away[3], # team_name
                '{ROUND_NAME}': match.round_name,
                '{MATCH_ID}': match_id,
                '{CHANNEL_ID}': str(match_channel.id),
                '{CHANNEL_LINK}': f'<#{match_channel.id}>'
            })
            match_message['embed'] = discord.Embed(**match_message['embeds'][0])
            del match_message['embeds']
            await match_channel.send(**match_message)
            # Update the database
            self.db.insert_match({
                'match_id': match_id,
                'division': team_home[5], # division
                'team_home': team_home[0], # team_id
                'team_away': team_away[0], # team_id
                'channel_id': match_channel.id,
                'league_id': match.league_id
            })
        
        await interaction.edit_original_response(content='Matches generated.')

    # @app_commands.command(
    #     name='roundend'
    # )
    # async def roundend(self, interaction : discord.Interaction, league_id : int, match_id : int = None):
    #     """End a round of a tournament and archive all channels

    #     Parameters
    #     -----------
    #     league_id: int
    #         The League ID to end the round for
    #     match_id: int (optional)
    #         OPTIONAL: Match ID to end. If not supplied, ends all matches currently active
    #     """
    #     await interaction.response.send_message('Ending round...', ephemeral=True)
    #     # Ending a Round: Need to follow these steps:
    #     # 1. Archive all channels #TODO
    #     # 2. Update the database to reflect these changes

    #     if match_id is not None:
    #         match = self.db.get_match_by_id(match_id)
    #         if match is None:
    #             await interaction.response.edit_message(content='Match not found.', ephemeral=True)
    #             return
    #         if match['channel_id'] == 0:
    #             await interaction.response.edit_message(content='Match is a bye, cannot end.', ephemeral=True)
    #             return
    #         if match['archived'] == 1:
    #             await interaction.response.edit_message(content='Match has already been archived.', ephemeral=True)
    #             return
    #         match_channel = discord.Object(id=match['channel_id'])
    #         await match_channel.send('Match has ended. This channel will now be archived.')
    #         # Make the channel read only
    #         overwrites = match_channel.overwrites
    #         for overwrite in overwrites:
    #             if overwrite[0] != interaction.guild.default_role:
    #                 overwrites[overwrite[0]] = discord.PermissionOverwrite(read_messages=True, send_messages=False)
    #         await match_channel.edit(overwrites=overwrites)

    #         # at this point we'd hand off to the archival process, but that's firmly TODO:
    #         # Update the database
    #         self.db.archive_match(match_id)

    #     await interaction.response.edit_message(content='Round ended. All channels have been archived.', ephemeral=True)

    @app_commands.command(
        name='roundend'
    )
    async def roundend(self, interaction : discord.Interaction, match_id : int):
        """End a round of a tournament and archive all channels

        Parameters
        -----------
        match_id: int
            Match ID to end
        """

        await interaction.response.send_message('Ending round...', ephemeral=True)

        match = self.db.get_match_by_id(match_id)
        if match is None:
            await interaction.response.edit_message(content='Match not found.', ephemeral=True)
            return
        if match[4] == 0: # channel_id
            await interaction.response.edit_message(content='Match is a bye, cannot end.', ephemeral=True)
            return
        if match[5] == 1: # archived
            await interaction.response.edit_message(content='Match has already been archived.', ephemeral=True)
            return
        #match_channel = discord.Object(id=match[4])
        match_channel = interaction.guild.get_channel(match[4])
        await match_channel.send('Match has ended. This channel will now be archived.')
        # Make the channel read only
        overwrites = match_channel.overwrites
        for role,perm in overwrites.items():
            if role.id != interaction.guild.default_role.id:
                overwrites[role] = discord.PermissionOverwrite(read_messages=True, send_messages=False)

        # for overwrite in overwrites:
        #     if overwrite != interaction.guild.default_role:
        #         overwrites[interaction.guild.default_role] = discord.PermissionOverwrite(read_messages=True, send_messages=False)

        await match_channel.edit(overwrites=overwrites)

        # at this point we'd hand off to the archival process, but that's firmly TODO:
        # Update the database
        self.db.archive_match(match_id)

        await interaction.edit_original_response(content='Round ended. All channels have been archived.')
    
    @app_commands.command(
        name='archive'
    )
    async def archive(self, interaction : discord.Interaction, match_id : int):
        """Archive all channels and roles for a league

        Parameters
        -----------
        match_id: int
            The Match ID to archive
        """
        await Logging.archive_match(match_id)

    # @tournament.error
    # async def tournament_error(self, ctx : discord.Interaction, error):
    #     if isinstance(error, discord_commands.errors.MissingPermissions):
    #         await ctx.response.send_message(content='You do not have permission to run this command.', ephermeral=True)
    #     else:
    #         await ctx.response.send_message(content='An error occurred while running this command.', ephermeral=True)


async def initialize(bot, db, cit, logger):
    await bot.add_cog(Tournament(bot, db, cit, logger), guilds=[discord.Object(id=os.getenv('DISCORD_GUILD_ID'))])
    # list = await bot.tree.sync(guild=discord.Object(id=os.getenv('DISCORD_GUILD_ID')))
    # logger.info(f'Loaded Tournament Commands: {list}')


#del discord, os, json, database, citadel, discord_commands
