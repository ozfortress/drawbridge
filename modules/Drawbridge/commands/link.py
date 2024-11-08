from ..checks import *
from ..functions import *
from ..logging import *
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

    division = discord.ui.Select(
        placeholder='Select Division',
        options=[
            discord.SelectOption(label='Open', value='Open'),
            discord.SelectOption(label='Main', value='Main'),
            discord.SelectOption(label='Intermediate', value='Intermediate'),
            discord.SelectOption(label='High', value='High'),
            discord.SelectOption(label='Premier', value='Premier'),
        ],
        min_values=1,
        max_values=1,
        label='Ozfortress Division',
    )

    team = discord.ui.TextInput(
        placeholder='https://ozfortress.com/teams/...',
        label='Ozfortress Team',
    )

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.send_message(f'Profile: {self.profile.value}\nDivision: {self.division.values[0]}\nTeam: {self.team.value}', ephemeral=True)

    async def on_error(self, interaction: discord.Interaction, error: Exception):
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

    @app_commands.command(name='link', description='Link your Citadel account with your Discord account.')
    async def link(self, interaction : discord.Interaction):
        await interaction.response.send_modal(LinkModal())

async def initialize(bot: discord_commands.Bot, db, cit, logger):
    await bot.add_cog(Link(bot, db, cit, logger), guilds=[bot.get_guild(int(os.getenv('DISCORD_GUILD_ID')))])
