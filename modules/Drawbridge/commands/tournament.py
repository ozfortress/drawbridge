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

from discord import app_commands
from discord.ext import commands as discord_commands
from discord.ext import tasks as discord_tasks

__title__ = 'Tournament Commands'
__description__ = 'Commands for managing tournaments.'
__version__ = '0.0.1'

checks = Checks()
@checks.is_head()
@discord.app_commands.guild_only()
class Tournament(discord_commands.GroupCog, group_name='tournament', name='tournamnet', group_description='Commands for managing tournaments. This is a new string',):
    def __init__(self, bot:discord_commands.Bot, db:database.Database, cit:citadel.Citadel, logger) -> None:
        self.bot = bot
        self.cit = cit
        self.db = db
        self.logger = logger
        self.logger.info('Loaded Tournament Commands.')
        self.functions = Functions(self.db, self.cit)

    @app_commands.command(
        name='test'
    )
    async def test(self, interaction : discord.Interaction):
        await interaction.response.send_message('Test command.', ephemeral=True)

    @app_commands.command(
        name='test'
    )
    async def test(self, interaction : discord.Interaction, league_id : int):
        league = self.cit.getLeague(league_id)
        rosters = league.rosters

        for roster in rosters:
            print(roster['name'] + ' ' + str(roster['team_id']))

        rawteammessage = json.load(open('embeds/teams.json', 'r'))
        await interaction.response.send_message(str(type(rawteammessage['embeds'])))

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

        await interaction.edit_original_response(content=f'Generating Division Categories, Team Channels, and Roles.\nLeague: {league.name}\nDivisions: {len(divs)}\nTeams: {len(rosters)}')
        r=0 #counters
        d=0 #counters
        for div in divs:
            d+=1
            overrides = {
                interaction.guild.default_role: discord.PermissionOverwrite(view_channel=False)
            }

            all_access = checks._get_role_ids('HEAD', 'ADMIN', '!AC', 'TRIAL', 'DEVELOPER', 'CASTER', 'BOT')
            for role in all_access:
                overrides[interaction.guild.get_role(role)] = discord.PermissionOverwrite(view_channel=True)

            channelcategory = await interaction.guild.create_category(f'{div} - {league_shortcode}', overwrites=overrides)

            role = await interaction.guild.create_role(name=f'{div} - {league_shortcode}')
            dbdiv = {
                'league_id': league_id,
                'division_name': div,
                'role_id': role.id,
                'category_id': channelcategory.id
            }
            i = 0
            divid = self.db.insert_div(dbdiv)
            for roster in rosters:
                if roster['division'] == div:
                    r+=1
                    role = await interaction.guild.create_role(name=f'{roster['name']} ({league_shortcode})', mentionable=True)
                    overwrites = {
                        interaction.guild.default_role: discord.PermissionOverwrite(view_channel=False),
                        role: discord.PermissionOverwrite(view_channel=True)
                    }

                    all_access = checks._get_role_ids('HEAD', 'ADMIN', 'TRIAL', 'DEVELOPER', 'BOT')
                    for permrole in all_access:
                        overrides[interaction.guild.get_role(permrole)] = discord.PermissionOverwrite(view_channel=True)
                    channel_name = f'🛡️{roster['name']} ({league_shortcode})'
                    if len(channel_name) > 45:
                        channel_name = f'🛡️{roster['name'][:20]} ({league_shortcode})'
                        self.logger.warning(f'Channel name for {roster['name']} is too long, trimming to {channel_name}')
                    teamchannel = await interaction.guild.create_text_channel(channel_name, category=channelcategory, overwrites=overwrites)
                    team_id = roster['team_id']
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
                    temprawteammessage = str(rawteammessage)
                    teammessage = json.loads(self.functions.substitute_strings_in_embed(temprawteammessage, subsitutions))
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

        await interaction.edit_original_response(content='Deleting channels... (1/3)')

        for channel in guild.channels:
            for team in teams:
                if channel.id == team[4]:
                    await channel.delete()
                    break
            for match_channel in match_channels:
                if channel.id == match_channel[0]:
                    await channel.delete()

        await interaction.edit_original_response(content='Deleting categories... (2/3)')

        for div in divs:
            for category in guild.categories:
                if category.id == div[4]:
                    await category.delete()
                    break
            for role in guild.roles:
                if role.id == div[3]:
                    await role.delete()
                    break

        await interaction.edit_original_response(content='Deleting roles... (3/3)')

        for role in guild.roles:
            for team in teams:
                if role.id == team[2]:
                    await role.delete()
                    break

        self.db.delete_matches_by_league(league_id)
        self.db.delete_teams_by_league(league_id)
        self.db.delete_divisions_by_league(league_id)


        await interaction.edit_original_response(content='Tournament ended. All channels and roles have been archived.')

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
        try:
            match = self.cit.getMatch(match_id)

            if self.db.get_match_by_id(match_id) is not None:
                await interaction.edit_original_response(content='This match has already been generated.')
                return

            rawmatchmessage = ''
            with open('embeds/match.json', 'r') as file:
                rawmatchmessage = file.read()

            if match.home_team is None:
                await interaction.edit_original_response(content='Match not found. See console output for more info')
                self.logger.error(f'Match not found: {match_id}')
                # try:
                #     self.logger.debug(f'match: {match}')
                # except Exception as e:
                #     self.logger.error(f'Error printing match: {e}')
                return
            if match.away_team is None:
                # This is a bye, we don't need to generate a channel for this.
                # self.logger.debug(f' ==== PASSING THIS {match.home_team['team_id']}')
                team_home = self.db.get_team_by_id(match.home_team['team_id'])
                # self.logger.debug(f'{match}')
                role_home = self.bot.get_guild(int(os.getenv('DISCORD_GUILD_ID'))).get_role(team_home[2])
                # team_channel = discord.Object(id=team_home[4])
                team_channel = self.bot.get_channel(team_home[4])
                await team_channel.send(f'Matches for round {match.round_number} were just generated. {role_home.mention} have a bye this round, and thus will be awarded a win.') #TODO - JSON embed for this
                self.db.insert_match({
                    'match_id': match.id,
                    'division': team_home[5],
                    'team_home': team_home[0],
                    'team_away': 0,
                    'channel_id': 0, # 0 for bye,
                    'league_id': match.league_id
                })
            else:
                # Team roles
                team_home = self.db.get_team_by_id(match.home_team['team_id'])
                team_away = self.db.get_team_by_id(match.away_team['team_id'])
                # Category ID for the division
                # category_id = self.db.get_div_by_name(match.home_team['division'])[4] # always pull from home team, 4 is category_id btw
                divs = self.db.get_divs_by_league(match.league_id) # Div name could be different depending on league. Account for this.
                if len(divs) == 0:
                    await interaction.edit_original_response(content='No divisions found for the league for this match???? Pester shigbeard, this shouldn\'t happen.')
                    return
                category_id = 0
                for d in divs:
                    if d[1] == match.home_team['division']:
                        category_id = d[4]
                        break
                if category_id == 0:
                    await interaction.edit_original_response(content='Division not found for the match. Pester shigbeard, this shouldn\'t happen.')
                    return

                overrides = {
                    interaction.guild.default_role: discord.PermissionOverwrite(view_channel=False),
                    interaction.guild.get_role(team_home[2]): discord.PermissionOverwrite(view_channel=True),
                    interaction.guild.get_role(team_away[2]): discord.PermissionOverwrite(view_channel=True),
                }
                all_access = checks._get_role_ids('HEAD', 'ADMIN', 'TRIAL', 'DEVELOPER', 'CASTER', 'BOT')
                for role in all_access:
                    overrides[interaction.guild.get_role(role)] = discord.PermissionOverwrite(view_channel=True)

                cat = self.bot.get_guild(int(os.getenv('DISCORD_GUILD_ID'))).get_channel(category_id)
                if match.round_name == '':
                    match.round_name = f'Round {match.round_number}'
                channel_name = f'🗡️-{match_id}-{team_home[3]}-vs-{team_away[3]}-{match.round_name}'
                trimmed = False
                if len(channel_name) > 100:
                    trimmed_home_team = team_home[3][:10]
                    trimmed_away_team = team_away[3][:10]
                    channel_name = f'🗡️{match_id}-{trimmed_home_team}-vs-{trimmed_away_team}-{match.round_name}'
                    self.logger.warning(f'Channel name too long when generating match {match.round_number} {team_home[3]} vs {team_away[3]}, trimming to {channel_name}')
                match_channel = await interaction.guild.create_text_channel(channel_name, category=cat, overwrites=overrides)
                # Load the message
                tempmatchmessage = str(rawmatchmessage)

                matchmessage = json.loads(self.functions.substitute_strings_in_embed(tempmatchmessage, {
                    '{TEAM_HOME}': f'<@&{team_home[2]}>', # team role as a mention
                    '{TEAM_AWAY}': f'<@&{team_away[2]}>', # team role as a mention
                    '{ROUND_NAME}': match.round_name,
                    '{MATCH_ID}': match_id,
                    '{CHANNEL_ID}': str(match_channel.id),
                    '{CHANNEL_LINK}': f'<#{match_channel.id}>'
                }))
                matchmessage['embed'] = discord.Embed(**matchmessage['embeds'][0])
                del matchmessage['embeds']
                await match_channel.send(**matchmessage)
                # Update the database
                self.db.insert_match({
                    'match_id': match_id,
                    'division': team_home[5], # division
                    'team_home': team_home[0], # team_id
                    'team_away': team_away[0], # team_id
                    'channel_id': match_channel.id,
                    'league_id': match.league_id
                })

                # Lets also say something in their team channel
                try:
                    team_home_channel = self.bot.get_channel(team_home[4]) # team_channel
                    team_away_channel = self.bot.get_channel(team_away[4]) # team_channel
                    await team_home_channel.send(f'Match for round {match.round_number} has been generated. Please head to {match_channel.mention} to organise your match.')
                    await team_away_channel.send(f'Match for round {match.round_number} has been generated. Please head to {match_channel.mention} to organise your match.')
                    if trimmed:
                        await team_home_channel.send(f'Heads up: Due to a discord limitation, we had to trim your match name down to {channel_name}. We apologise for any inconvenience.')
                        await team_away_channel.send(f'Heads up: Due to a discord limitation, we had to trim your match name down to {channel_name}. We apologise for any inconvenience.')
                except Exception as e:
                    self.logger.error(f'Error sending message to team channels: {e}')

            await interaction.edit_original_response(content='Matches generated.')
        except Exception as e:
            self.logger.error(f'Error generating match: {e}', exc_info=True)
            await interaction.edit_original_response(content=f'An error occurred while generating matches.\n ```\n{e}\n```')

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
            await interaction.response.edit_message(content='Match not found.')
            return
        if match[4] == 0: # channel_id
            await interaction.response.edit_message(content='Match is a bye, cannot end.')
            return
        if match[5] == 1: # archived
            await interaction.response.edit_message(content='Match has already been archived.')
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
            name='randomdemocheck',
            description='Still WIP. Currently chooses a random team in any div'
    )
    async def randomdemocheck(self, interaction : discord.Interaction, league_id : int, round_no : int, spes_user: int = 0):
        """Conduct a random demo check.

        Parameters
        -----------
        league_id: int
            league to demo check

        round_no:
            the round that admins will check

        spes_user:
            does nothing atm but will be used to target a specific player
        """
        await interaction.response.send_message('Democheck is in progress ...', ephemeral=True)
        try:
            league = self.cit.getLeague(league_id)
            if league is None:
                await interaction.edit_original_response(content='League not found. Aborting.', ephemeral=True)
                return
            if self.db.get_divs_by_league(league_id) is None:
                await interaction.edit_original_response(content='League not being monitored. Aborting.', ephemeral=True)
                return
            
            matches = [m for m in league.matches]
            for m in matches:
                if m['round_number'] != round_no and m['forfeit_by'] != 'no_forfeit': #and m['away_team'] is not None
                    matches.remove(m)

            if len(matches) == 0:
                await interaction.edit_original_response(content=f'No matches were found for round {round_no}. Aborting.', ephemeral=True)
                return

            random.shuffle(matches)
            match_chosen = matches[random.randint(0, len(matches)-1)]

            #Get log of match here
            log = requests.get('https://logs.tf/api/v1/log/3757893').json() #WILL ONLY TEST FOR THIS LOG ATM

            # morbid curiosity time - shig

            r_id = [id['id'] for id in league.rosters]
            r_roster = [self.cit.getRoster(r) for r in r_id ]
            r_players = [pl for p in r_roster for pl in p.players]
            if (len(r_players) == 0):
                await interaction.edit_original_response(content=f'No players were found. Aborting.', ephemeral=True)
                return

            for player in r_players:
                if player['steam_32'] not in log['names']: #logs.tf uses the 32 bit steam ID for who played
                    r_players.remove(player)

            chosen_player = r_players[random.randint(0, len(r_players)-1)]
            chosem_match = self.cit.getMatch(match_chosen['id'])
            if  chosem_match['home_team'] in chosem_match['rosters']:
                chosen_team = chosem_match.home_team
            else:
                chosen_team = chosem_match.away_team

            t = self.db.get_team_by_id(chosen_team.id)

            messageraw = ''
            with open('embeds/democheck.json', 'r') as file:
                messageraw = file.read()
            tempmsg = str(messageraw)

            await interaction.edit_original_response(content=f'Random demo check announced. Player chosen is: {chosen_player.name}', ephemeral=True)

            demochkmsg = json.loads(self.functions.substitute_strings_in_embed(tempmsg, {
                '{TEAM_NAME}'   : f'<@&{t['role_id']}>',
                '{TARGET_NAME}' : f'{chosen_player.name}',
                '{TARGET_ID}'   : f'{chosen_player.id}',
                '{MATCH_PAGE}'  : f'tbd',
                '{MATCH_ID}'    : f'tbd'
            }))
            self.bot.get_channel(t['channel'])
            demochkmsg['embed'] = discord.Embed(**demochkmsg['embeds'][0])
            del demochkmsg['embeds']
            await t['team'].send(**demochkmsg)

        except Exception as e:
            self.logger.error(f'Error conducting demo check: {e}', exc_info=True)
            await interaction.edit_original_response(content=f'An error occurred while announcing the random demo check. Error: {e}. Line {e.__traceback__.tb_lineno}.')

    # @app_commands.command(
    #         name='randomdemocheck',
    #         description='Announces a truly random demo check, given a League ID. Automatically picks a team in the league, and a match to check'
    # )
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
        name='launchpad',
        description='Generate a launchpad for all matches and team channels currently active'
    )
    async def launchpad(self, interaction : discord.Interaction, share : bool=False):
        # self.logger.debug(f'Generating Launchpad. Share: {share}')
        await interaction.response.send_message('Generating Launchpad...', ephemeral=(not share))
        teams = self.db.get_all_teams()
        matches = self.db.get_matches_not_yet_archived()
        leagueids = []
        leagues=[]
        divids=[]
        divs=[]
        for team in teams:
            if team[1] not in leagueids:
                leagueids.append(team[1])
                leagues.append(self.cit.getLeague(team[1]))
            if team[5] not in divids:
                divids.append(team[5])
                divs.append(self.db.get_div_by_id(team[5]))


        rawlaunchpadmessage = ''
        for leagues in leagues:
            rawlaunchpadmessage += f'# {leagues.name}\n'
            for div in divs:
                if div[2] == leagues.id: ## Does the league_id field match the league we're looking at?
                    rawlaunchpadmessage += f'## {div[1]}\n'
                    rawlaunchpadmessage += f'### Teams\n'
                    for team in teams:
                        if (team[1] == leagues.id) and (team[5] == div[0]):
                            rawlaunchpadmessage += f'- {team[3]} -> <#{team[4]}>\n'
                    rawlaunchpadmessage += f'### Matches\n'
                    for match in matches:
                        # self.logger.debug(f'Match league id {match[6]} == {leagues.id} and match div id {match[1]} == {div[0]}')
                        if (int(match[6]) == int(leagues.id)) and (int(match[1]) == int(div[0])):
                            if match[4] == 0:
                                rawlaunchpadmessage += f'- [{match[0]}](<https://ozfortress.com/matches/{match[0]}>) -> Bye\n'
                            else:
                                rawlaunchpadmessage += f'- [{match[0]}](<https://ozfortress.com/matches/{match[0]}>) -> <#{match[4]}>\n'
                    rawlaunchpadmessage += '\n'
        launchpadmessages = []
        # split on the first \n under 2000 chars
        while len(rawlaunchpadmessage) > 2000:
            index = rawlaunchpadmessage[:2000].rfind('\n')
            launchpadmessages.append(rawlaunchpadmessage[:index])
            rawlaunchpadmessage = rawlaunchpadmessage[index:]
        launchpadmessages.append(rawlaunchpadmessage)
        for message in launchpadmessages:
            await interaction.followup.send(content=message, ephemeral=(not share))

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


async def initialize(bot: discord_commands.Bot, db, cit, logger):
    await bot.add_cog(Tournament(bot, db, cit, logger), guilds=[bot.get_guild(int(os.getenv('DISCORD_GUILD_ID')))])
    # list = await bot.tree.sync(guild=discord.Object(id=os.getenv('DISCORD_GUILD_ID')))
    # logger.info(f'Loaded Tournament Commands: {list}')


#del discord, os, json, database, citadel, discord_commands
