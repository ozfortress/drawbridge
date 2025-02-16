from ..checks import *
from ..functions import *
from ..logging import *
import logging
import discord
import os
import json
import random
from modules import database
from modules import citadel

from discord import app_commands
from discord.ext import commands as discord_commands
from discord.ext import tasks as discord_tasks

__title__ = "Link"
__description__ = "Link a user on the server to their Citadel Account"
__version__ = "1.0.0"

checks = Checks()

class LinkModal(discord.ui.Modal, title='Link Account'):

    profile = discord.ui.TextInput(
        placeholder='https://ozfortress.com/users/...',
        label='Ozfortress Profile',
    )

    # division = discord.ui.Select(
    #     placeholder='Select Division',
    #     options=[
    #         discord.SelectOption(label='Open', value='Open'),
    #         discord.SelectOption(label='Main', value='Main'),
    #         discord.SelectOption(label='Intermediate', value='Intermediate'),
    #         discord.SelectOption(label='High', value='High'),
    #         discord.SelectOption(label='Premier', value='Premier'),
    #     ],
    #     min_values=1,
    #     max_values=1
    # )

    team = discord.ui.TextInput(
        placeholder='https://ozfortress.com/teams/...',
        label='Ozfortress Team',
    )

    async def on_submit(self, interaction: discord.Interaction):
        # await interaction.response.send_message(f'Profile: {self.profile.value}\nTeam: {self.team.value}', ephemeral=True)
        # verify profile
        # await interaction.response.send_message('Checking your profile and team...', ephemeral=True)
        profile = self.profile.value
        team = self.team.value  
        if not profile.startswith('https://ozfortress.com/users/') or not team.startswith('https://ozfortress.com/teams/'):
            await interaction.response.send_message('Invalid profile or team link. Please make sure you are using the correct links.', ephemeral=True)
            return
        # verify team
        citadelapi = citadel.Citadel(
            os.getenv('CITADEL_API_KEY'),
            baseURL=os.getenv('CITADEL_API_HOST')
        )
        db = database.Database(
            {
                'host': os.getenv('DB_HOST'),
                'user': os.getenv('DB_USER'),
                'password': os.getenv('DB_PASS'),
                'database': os.getenv('DB_DATABASE'),
                'pool_name': 'drawbridgeLink'
            }
        )
        team_id = team.split('/')[-1]
        # reject if team_id is not a number
        if not team_id.isdigit():
            await interaction.response.send_message('Invalid team link. Please make sure you are using the correct links.',  ephemeral=True)
            return
        cteam = citadelapi.getTeam(team_id)
        if not cteam:
            await interaction.response.send_message('Inavalid team link. Please make sure you are using the correct links.', ephemeral=True)
            return

        all_teams = db.get_all_teams()
        if len(all_teams) == 0:
            await interaction.response.send_message('Sorry, there appears to be no active tournaments at the moment. Please try again later.', ephemeral=True)
            return
        all_teams = [team for team in all_teams if team[1] == int(team_id)]
        if len(all_teams) == 0:
            await interaction.response.send_message('Sorry, that team is not rostered in any currently active tournaments. You can get your roles once seedings have been completed.', ephemeral=True)
            return
        
        # is the profile valid?
        user_id = profile.split('/')[-1]
        if not user_id.isdigit():
            await interaction.response.send_message('Invalid profile link. Please make sure you are using the correct links.',  ephemeral=True)
            return
        cuser = citadelapi.getUser(user_id)
        if not cuser:
            await interaction.response.send_message('Invalid profile link. Please make sure you are using the correct links.',  ephemeral=True)
            return
        
        # find all teams the user is a captain in.
        # teams = []
        roles = []
        for team in all_teams:
            # get their roster
            t = citadelapi.getTeam(team[1])
            for player in t.players:
                player = citadelapi.PartialUser(player)
                if player.is_captain and player.id == cuser.id:
                    # found a team they are captain in
                    # add them to their team roles
                    roles.append(interaction.guild.get_role(int(team[3])))
                    break
        if len(roles) == 0:
            await interaction.response.send_message('You are not a captain in any of the teams rostered in the current tournaments. Please try again later.', ephemeral=True)
            return
        # assign roles
        roles.append(interaction.guild.get_role(int(os.getenv('ROLE_CAPTAIN'))))
        await interaction.user.add_roles(*roles, reason=f'Linked via Drawbridge to Citadel User ID: {cuser.id}')
        await interaction.response.send_message('Successfully linked your account and assigned roles.',  ephemeral=True)
        return
        

    async def on_error(self, interaction: discord.Interaction, error: Exception):
        import traceback
        logger = logging.getLogger('discord')
        logger.error(f'An error occurred: {error}\n{traceback.format_exc()}')
        logger.error(f'An error occurred: {error}')
        
        await interaction.response.send_message(f'An error occurred: \n```\n{error}\n```', ephemeral=True)


@discord.app_commands.guild_only()
class Link(discord_commands.Cog):
    def __init__(self, bot:discord_commands.Bot, db:database.Database, cit:citadel.Citadel, logger) -> None:
        self.bot = bot
        self.cit = cit
        self.db = db
        self.logger = logger
        self.logger.info('Loaded Link Command.')
        self.functions = Functions(self.db, self.cit)

    @discord_commands.Cog.listener()
    async def on_member_join(self, member):
        channel = member.guild.system_channel
        if channel is not None:
            await channel.send(f'Welcome {member.mention}! Please link your Citadel account with the command `/link`.')
            #pass # Disable welcome message for now

    @app_commands.command(name='link', description='Link your Citadel account with your Discord account.')
    async def link(self, interaction : discord.Interaction):
        await interaction.response.send_modal(LinkModal())

async def initialize(bot: discord_commands.Bot, db, cit, logger):
    await bot.add_cog(Link(bot, db, cit, logger), guilds=[bot.get_guild(int(os.getenv('DISCORD_GUILD_ID')))])
