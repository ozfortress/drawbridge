from ..checks import *
from ..functions import *
from ..logging import *
import discord
import os
import json
from modules import database
from modules import citadel

from discord.ext import commands as discord_commands

__title__ = 'Tournament Commands'
__description__ = 'Commands for managing tournaments.'
__version__ = '0.0.1'


class Tournament(discord_commands.GroupCog, group_name='tournament', name='tournamnet', group_description='Commands for managing tournaments.'):
    def __init__(self, command_tree : discord.app_commands.CommandTree, db : database.Database, cit : citadel.Citadel):
        group = discord.app_commands.Group(name='tournament', description='Commands for managing ozfortress tournaments, including generating match channels and starting/ending tournaments')

        @Checks.heads_only()
        @command_tree.command(
            name='tournament',
            guild=discord.Object(id=os.getenv('DISCORD_GUILD_ID'))
        )
        async def tournament(interaction : discord.Interaction):
            """Base command for tournament management"""
            await interaction.response.send_message('Please specify a subcommand.', ephemeral=True)




        @tournament.command(
            name='start',
            guild=discord.Object(id=os.getenv('DISCORD_GUILD_ID'))
        )
        async def start(interaction : discord.Interaction, league_id : int, league_shortcode : str, is_hl : bool = False):
            """Generate team roles and channels for a given league

            Parameters
            -----------
            league_id: int
                The League ID to generate teams for
            league_shortcode: str
                The Shortcode for this league (eg: HL 27, 6s 30 ), this will be appended to role names.
            is_hl: bool
                Whether the league is Highlander or not. Default is False.
            """
            await interaction.response.send_message('Generating teams...', ephemeral=True)
            league = cit.getLeague(league_id)
            rosters = league.rosters
            divs = []
            file = open('embeds/teams.json', 'r')
            for roster in rosters:
                if roster['division'] not in divs:
                    divs.append(roster['division'])
                # trim team name to 20 char
                roster['role_name'] = f'{roster['name'][:20]} ({league_shortcode})'
                # role = await ctx.guild.create_role(name=role_name)
                # db.insert_team(roster)

            await interaction.response.edit_message(content=f'Generating Division Categories, Team Channels, and Roles.\nLeague: {league['name']}\nDivisions: {len(divs)}\nTeams: {len(rosters)}')
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
                    'division': div,
                    'role_id': role.id,
                    'category_id': channelcategory.id
                }
                divid = db.insert_div(dbdiv)
                for roster in rosters:
                    if roster['division'] == div:
                        r+=1
                        role = await interaction.guild.create_role(name=f'{roster['name']} ({league_shortcode})', mentionable=True)
                        overwrites = {
                            role: discord.PermissionOverwrite(read_messages=True),
                        }
                        teamchannel = await interaction.guild.create_text_channel(f'{roster['name']} ({league_shortcode})', category=channelcategory, overwrites=overwrites)

                        # Load the chat message from embeds/teams.json

                        teammessage = json.load(file)
                        teammessage = Functions.substitute_strings_in_embed(teammessage, {
                            '{TEAM_MENTION}': f'<@&{role.id}>',
                            '{TEAM_NAME}': roster['name'],
                            '{TEAM_ID}': roster['id'],
                            '{DIVISION}': div,
                            '{LEAGUE_NAME}': league['name'],
                            '{LEAGUE_SHORTCODE}': league_shortcode,
                            '{CHANNEL_ID}': str(teamchannel.id),
                            '{CHANNEL_LINK}': f'<#{teamchannel.id}>',
                        })
                        teammessage['embed'] = teammessage['embeds'][0]
                        del teammessage['embeds']
                        await teamchannel.send(**teammessage)
                        await interaction.response.edit_message(content=f'Generating Division Categories, Team Channels, and Roles.\nLeague: {league['name']}\nDivisions: {d}/{len(divs)}\nTeams: {r}/{len(rosters)}')
                        dbteam = {
                            'team_id': roster['id'],
                            'role_id': role.id,
                            'team_channel': teamchannel.id,
                            'division': divid,
                            'team_name': roster['name']
                        }
                        db.insert_team(dbteam)
            await interaction.response.edit_message(content=f'Generated.\nLeague: {league['name']}\nDivisions: {d}/{len(divs)}\nTeams: {r}/{len(rosters)}')

        @tournament.command(
            name='end',
            guild=discord.Object(id=os.getenv('DISCORD_GUILD_ID'))
        )
        async def end(interaction : discord.Interaction, league_id : int):
            """End a tournament and archive all channels and roles

            Parameters
            -----------
            league_id: int
                The League ID to end the tournament for
            """
            await interaction.response.send_message('Ending tournament...', ephemeral=True)
            # Ending a League: Need to follow these steps:
            # 1. Archive all channels // NOT IMPLEMENTED, SKIP FOR NOW
            # 2. Delete all team roles
            # 3. Delete all team channels
            # 4. Delete all division roles
            # 5. Delete all division categories
            # 6. Delete all league roles
            # 7. Delete all league categories
            # 8. Delete all league channels
            # Update the database to reflect these changes at each step
            # TODO




            await interaction.response.edit_message(content='Tournament ended. All channels and roles have been archived.', ephemeral=True)

        @tournament.command(
            name='roundgen',
            guild=discord.Object(id=os.getenv('DISCORD_GUILD_ID'))
        )
        async def roundgen(interaction : discord.Interaction, league_id : int, round_number : int = None):
            """Generate match channels for a given round of a league

            Parameters
            -----------
            league_id: int
                The League ID to generate matches for
            round_number: int (optional)
                The round number to generate matches for. If not provided, will generate all matches to date.
            """
            await interaction.response.send_message('Generating matches...', ephemeral=True)
            league = cit.getLeague(league_id)
            # loop through league.matches and generate channels for each match, provided they are in the correct round
            for match in league.matches:
                if round_number is None or match['round_number'] == round_number:
                    # generate match channels
                    round = cit.getMatch(match['id'])
                    # Did we already generate this match?
                    if db.get_match_by_id(match['id']) is not None:
                        # We already generated this match, skip it.
                        continue
                    # Is this a bye?
                    elif round.away_team is None:
                        # This is a bye, we don't need to generate a channel for this.
                        team_home = db.get_team_by_id(round['home_team'])
                        role_home = discord.Object(id=team_home['role_id'])
                        team_channel = discord.Object(id=team_home['team_channel'])
                        await team_channel.send(f'Matches for round {match['round_number']} were just generated. {role_home.mention} have a bye this round, and thus will be awarded a win.') #TODO - JSON embed for this
                        db.insert_match({
                            'match_id': match['id'],
                            'division': team_home['division'],
                            'team_home': team_home['team_id'],
                            'team_away': 0,
                            'channel_id': 0 # 0 for bye
                        })
                    else:
                        # We now know who the two teams are, lets get their roles
                        team_home = db.get_team_by_id(round['home_team'])
                        team_away = db.get_team_by_id(round['away_team'])
                        # Team roles
                        role_home = discord.Object(id=team_home['role_id'])
                        role_away = discord.Object(id=team_away['role_id'])
                        # Category ID for the division
                        category_id = db.get_div_(team_home['team_id'])['category_id'] # always pull from home team

                        # Create the match channel
                        overrides = {
                            role_home: discord.PermissionOverwrite(read_messages=True),
                            role_away: discord.PermissionOverwrite(read_messages=True),
                            Checks.roles['6s Head']: discord.PermissionOverwrite(read_messages=True),
                            Checks.roles['HL Head']: discord.PermissionOverwrite(read_messages=True),
                            Checks.roles['Trial Admin']: discord.PermissionOverwrite(read_messages=True),
                            Checks.roles['Developers']: discord.PermissionOverwrite(read_messages=True),
                            Checks.roles['Approved Casters']: discord.PermissionOverwrite(read_messages=True),
                            Checks.roles['Unapproved Casters']: discord.PermissionOverwrite(read_messages=True),
                            Checks.roles['Captains Bot']: discord.PermissionOverwrite(read_messages=True),
                            Checks.roles['HL Admin']: discord.PermissionOverwrite(read_messages=True),
                            Checks.roles['6s Admin']: discord.PermissionOverwrite(read_messages=True),
                            interaction.guild.default_role: discord.PermissionOverwrite(read_messages=False)
                        }
                        match_channel = await interaction.guild.create_text_channel(f'{team_home['team_name']}-⚔️-{team_away['team_name']}-Round-{match['round_number']}-{match['id']}', category=discord.Object(id=category_id), overwrites=overrides)
                        # Load the chat message from embeds/match.json
                        match_message = json.load(open('embeds/match.json', 'r'))
                        if match['round_name'] == '':
                            match['round_name'] = f'Round {match['round_number']}'
                        match_message = Functions.substitute_strings_in_embed(match_message, {
                            '{TEAM_HOME}': team_home['team_name'],
                            '{TEAM_AWAY}': team_away['team_name'],
                            '{ROUND_NAME}': match['round_name'],
                            '{MATCH_ID}': match['id'],
                            '{CHANNEL_ID}': str(match_channel.id),
                            '{CHANNEL_LINK}': f'<#{match_channel.id}>'
                        })
                        match_message['embed'] = match_message['embeds'][0]
                        del match_message['embeds']
                        await match_channel.send(**match_message)
                        # Update the database
                        db.insert_match({
                            'match_id': match['id'],
                            'division': team_home['division'],
                            'team_home': team_home['team_id'],
                            'team_away': team_away['team_id'],
                            'channel_id': match_channel.id
                        })
            await interaction.response.edit_message(content='Matches generated.', ephemeral=True)

        @tournament.command(
            name='roundend',
            guild=discord.Object(id=os.getenv('DISCORD_GUILD_ID'))
        )
        async def roundend(interaction : discord.Interaction, league_id : int, match_id : int = None):
            """End a round of a tournament and archive all channels

            Parameters
            -----------
            league_id: int
                The League ID to end the round for
            match_id: int (optional)
                OPTIONAL: Match ID to end. If not supplied, ends all matches currently active
            """
            await interaction.response.send_message('Ending round...', ephemeral=True)
            # Ending a Round: Need to follow these steps:
            # 1. Archive all channels #TODO
            # 2. Update the database to reflect these changes

            if match_id is not None:
                match = db.get_match_by_id(match_id)
                if match is None:
                    await interaction.response.edit_message(content='Match not found.', ephemeral=True)
                    return
                if match['channel_id'] == 0:
                    await interaction.response.edit_message(content='Match is a bye, cannot end.', ephemeral=True)
                    return
                if match['archived'] == 1:
                    await interaction.response.edit_message(content='Match has already been archived.', ephemeral=True)
                    return
                match_channel = discord.Object(id=match['channel_id'])
                await match_channel.send('Match has ended. This channel will now be archived.')
                # Make the channel read only
                overwrites = match_channel.overwrites
                for overwrite in overwrites:
                    if overwrite[0] != interaction.guild.default_role:
                        overwrites[overwrite[0]] = discord.PermissionOverwrite(read_messages=True, send_messages=False)
                await match_channel.edit(overwrites=overwrites)

                # at this point we'd hand off to the archival process, but that's firmly TODO:
                # Update the database
                db.archive_match(match_id)

            await interaction.response.edit_message(content='Round ended. All channels have been archived.', ephemeral=True)

        @tournament.command(
            name='archive',
            guild=discord.Object(id=os.getenv('DISCORD_GUILD_ID'))
        )
        async def archive(interaction : discord.Interaction, match_id : int):
            """Archive all channels and roles for a league

            Parameters
            -----------
            match_id: int
                The Match ID to archive
            """
            await Logging.archive_match(match_id)

        @tournament.error
        async def tournament_error(ctx : discord.Interaction, error):
            if isinstance(error, discord_commands.errors.MissingPermissions):
                await ctx.response.send_message(content='You do not have permission to run this command.', ephermeral=True)
            else:
                await ctx.response.send_message(content='An error occurred while running this command.', ephermeral=True)


def initialize(drawbridge):
    Tournament(drawbridge.cmd_tree, drawbridge.db, drawbridge.cit)

del discord, os, json, database, citadel, discord_commands
