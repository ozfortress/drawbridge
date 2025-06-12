from ..checks import *
from ..functions import *
from ..logging import *
import logging
import discord
import os
from typing import Optional
from modules import database
from modules import citadel

from discord import app_commands
from discord.ext import commands as discord_commands

__title__ = "Sync"
__description__ = "Sync a user on the server to their Citadel Account"
__version__ = "1.0.0"

checks = Checks()


@discord.app_commands.guild_only()
class Sync(discord_commands.Cog):
    def __init__(self, bot: discord_commands.Bot, db: database.Database, cit: citadel.Citadel, logger) -> None:
        self.bot = bot
        self.cit = cit
        self.db = db
        self.logger = logger
        self.logger.info('Loaded Sync Commands.')
        self.functions = Functions(self.db, self.cit)
        self.log_channel = bot.get_channel(int(os.getenv('SYNC_LOG_CHANNEL')))

    async def _channel_log(self, message: str):
        await self.log_channel.send(message)

    async def _sync_user(self, target: discord.User, interaction: discord.Interaction):
        src = interaction.user
        about_self = target.id == src.id
        forced_log = f" (Forced by <@{src.id}>)" if not about_self else ""
        user: Optional[User] = self.cit.getUserByDiscordID(target.id)
        name = target.name + "’s" if not about_self else "Your"
        if user is None:
            extra_intruction = " Be sure to link it with this Discord account at [ozfortress.com](https://ozfortress.com) in `Settings → Connections`." if about_self else ""
            await interaction.response.send_message(content=f"{name} Discord account is not linked to the ozfortress website.{extra_intruction}", ephemeral=True)
            await self._channel_log(f"<@{target.id}> tried to link their Discord but did not have a linked ozfortress account.{forced_log}")
        else:
            citadel_acc_link = f"[{user.name}](https://ozfortress.com/users/{user.id})"
            if self.db.discord_user_has_synced(user.discord_id):
                self.db.update_user(user.id, user.discord_id, user.steam_64)
                await interaction.response.send_message(content=f"{name} ozfortress account has been updated to {citadel_acc_link}", ephemeral=True)
                await self._channel_log(f"<@{target.id}> updated their ozfortress account to {citadel_acc_link}.{forced_log}")
            else:
                self.db.insert_user(user.id, user.discord_id, user.steam_64)
                await interaction.response.send_message(content=f"{name} Discord account has been linked to {citadel_acc_link}", ephemeral=True)
                await self._channel_log(f"<@{target.id}> linked their ozfortress account to {citadel_acc_link}.{forced_log}")

    @app_commands.command(
        name='sync',
        description='Sync your Discord account with the ozfortress website'
    )
    async def sync(self, interaction: discord.Interaction):
        """Sync command

        Add appropriate team captain roles to the user who runs this command.
        """
        await self._sync_user(interaction.user, interaction)

    @app_commands.command(
        name='force-sync',
        description='Sync a user’s ozfortress account with their Discord'
    )
    @checks.has_roles(
        'DIRECTOR',
        'HEAD',
        'DEVELOPER',
        'ADMIN',
        'TRIAL',
    )
    async def force_sync(self, interaction: discord.Interaction, target: discord.User):
        """Force Sync command

        Add appropriate team captain roles to the target Discord user.
        """
        await self._sync_user(target, interaction)


async def initialize(bot: discord_commands.Bot, db, cit, logger):
    await bot.add_cog(Sync(bot, db, cit, logger), guilds=[bot.get_guild(int(os.getenv('DISCORD_GUILD_ID')))])
