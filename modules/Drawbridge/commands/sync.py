from ..checks import *
from ..functions import *
from ..logging import *
import logging
import discord
import os
from typing import Optional
from modules import database
from modules import citadel
from modules.logging_config import get_logger, log_command_execution

from discord import app_commands
from discord.ext import commands as discord_commands

__title__ = "Sync"
__description__ = "Sync a user on the server to their Citadel Account"
__version__ = "1.0.0"

checks = Checks()
logger = get_logger('drawbridge.sync', 'sync.log')


class SyncButtonView(discord.ui.View):
    """Persistent view for sync buttons"""
    
    def __init__(self, cog: 'Sync'):
        super().__init__(timeout=None)  # Persistent view
        self.cog = cog
    
    @discord.ui.button(
        label='🔗 Sync ozfortress Account',
        style=discord.ButtonStyle.primary,
        custom_id='sync_button'
    )
    async def sync_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        """Handle sync button clicks"""
        logger.info(f"Sync button clicked by {interaction.user} (ID: {interaction.user.id})")
        await interaction.response.defer(ephemeral=True, thinking=True)
        await self.cog._sync_user(interaction.user, interaction)


@discord.app_commands.guild_only()
class Sync(discord_commands.Cog):
    def __init__(self, bot: discord_commands.Bot, db: database.Database, cit: citadel.Citadel, main_logger) -> None:
        self.bot = bot
        self.cit = cit
        self.db = db
        self.logger = logger  # Use the centralized logger instead
        self.logger.info('Loaded Sync Commands.')
        self.functions = Functions(self.db, self.cit)
        self.log_channel = bot.get_channel(int(os.getenv('SYNC_LOG_CHANNEL')))
        
        # Add persistent view for sync buttons
        self.bot.add_view(SyncButtonView(self))

    async def _channel_log(self, message: str):
        await self.log_channel.send(message)
        
    @discord_commands.Cog.listener()
    async def on_member_join(self, member: discord.Member):
        try:
            self._sync_user(member)
        except Exception as e:
            logger.error(f"Error syncing user on join: {e}", exc_info=True)
            

    async def _sync_user(self, target: discord.User, interaction: Optional[discord.Interaction] = None):
        src = interaction.user if interaction else None
        about_self = (src.id == target.id) if src else False
        forced_log = f" (Forced by <@{src.id}>)" if not about_self else ""
        automated = " (Automated on join)" if src is None else ""
        user: Optional[citadel.Citadel.User] = self.cit.getUserByDiscordID(target.id)
        name = target.name + "'s" if not about_self else "Your"
        
        if user is None:
            extra_intruction = " Be sure to link it with this Discord account at [ozfortress.com](https://ozfortress.com) in `Settings → Connections`." if about_self else ""
            if interaction:
                await interaction.followup.send(content=f"{name} Discord account is not linked to the ozfortress website.{extra_intruction}", ephemeral=True)
            await self._channel_log(f"<@{target.id}> tried to link their Discord but did not have a linked ozfortress account.{forced_log}{automated}")
        else:
            citadel_acc_link = f"[{user.name}](https://ozfortress.com/users/{user.id})"
            
            # Update or insert synced user record
            if self.db.synced_users.has_synced_discord(user.discord_id):
                # Update existing synced user
                user_data = {
                    'citadel_id': user.id,
                    'steam_id': user.steam_64
                }
                self.db.synced_users.update(user.discord_id, user_data)
                logger.info(f"Updated synced user record for {user.name} (Discord ID: {user.discord_id})")
                status_message = f"{name} ozfortress account has been updated to {citadel_acc_link}"
                log_message = f"<@{target.id}> updated their ozfortress account to {citadel_acc_link}.{forced_log}{automated}"
            else:
                # Insert new synced user
                user_data = {
                    'citadel_id': user.id,
                    'discord_id': user.discord_id,
                    'steam_id': user.steam_64
                }
                self.db.synced_users.insert(user_data)
                logger.info(f"Created new synced user record for {user.name} (Discord ID: {user.discord_id})")
                status_message = f"{name} Discord account has been linked to {citadel_acc_link}"
                log_message = f"<@{target.id}> linked their ozfortress account to {citadel_acc_link}.{forced_log}{automated}"
            
            # Now assign roles based on team captaincy
            roles_assigned = await self._assign_captain_roles(user, target)
            
            if roles_assigned:
                status_message += f"\n\nRoles assigned: {', '.join(roles_assigned)}"
                log_message += f" Roles assigned: {', '.join(roles_assigned)}"
            if interaction:
                await interaction.followup.send(content=status_message, ephemeral=True)
            await self._channel_log(log_message)
    
    async def _assign_captain_roles(self, citadel_user: citadel.Citadel.User, discord_user: discord.User) -> list[str]:
        """
        Assign team captain roles to a user based on their team captaincy.
        Returns a list of role names that were assigned.
        """
        assigned_roles = []
        # logger.debug(citadel_user)
        try:
            guild = self.bot.get_guild(int(os.getenv('DISCORD_GUILD_ID')))
            member = guild.get_member(discord_user.id) if guild else None
            
            if not member:
                logger.warning(f"User {citadel_user.name} (Discord ID: {discord_user.id}) is not in the server")
                return assigned_roles
            
            # Get the user's teams from Citadel (this includes captaincy info)
            user_teams = citadel_user.teams
            
            for team_data in user_teams:
                team_id = team_data['id']  # Extract team ID from dictionary
                full_team_data = self.cit.getTeam(team_id)
                users = full_team_data.players if full_team_data else []
                
                # Check if user is captain of this team
                is_captain = False
                for u in users:
                    if u['id'] == citadel_user.id and u.get('is_captain', False):
                        is_captain = True
                        break
                
                if is_captain:
                    logger.info(f"User {citadel_user.name} is captain of team ID: {team_id}")   
                    team_db = self.db.teams.get_by_team_id(team_id)
                    if team_db:
                        role_id = team_db.get('role_id')
                        if role_id:
                            role = guild.get_role(role_id)
                            if role and role not in member.roles:
                                await member.add_roles(role, reason="Drawbridge sync: Team captain role")
                                assigned_roles.append(f"Team: {role.name}")
                                logger.info(f"Assigned team role {role.name} to {citadel_user.name}")
                
                
                
        except Exception as e:
            logger.error(f"Error in role assignment for {citadel_user.name}: {e}")
        
        return assigned_roles

    @app_commands.command(
        name='sync',
        description='Sync your Discord account with the ozfortress website'
    )
    async def sync(self, interaction: discord.Interaction):
        """Sync command

        Add appropriate team captain roles to the user who runs this command.
        """
        logger.info(f"Sync command executed by {interaction.user} (ID: {interaction.user.id})")
        await interaction.response.defer(ephemeral=True, thinking=True)
        await self._sync_user(interaction.user, interaction)

    @app_commands.command(
        name='force-sync',
        description='Sync a user\'s ozfortress account with their Discord'
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
        logger.info(f"Force sync command executed by {interaction.user} (ID: {interaction.user.id}) for target {target} (ID: {target.id})")
        await interaction.response.defer(ephemeral=True, thinking=True)
        await self._sync_user(target, interaction)

    @app_commands.command(
        name='create-sync-button',
        description='Create an embedded sync button for users to click'
    )
    @app_commands.describe(
        title="Title for the embed (optional)",
        description="Description for the embed (optional)",
        channel="Channel to send the button to (optional, defaults to current channel)"
    )
    @checks.has_roles(
        'DIRECTOR',
        'HEAD',
        'DEVELOPER',
        'ADMIN',
    )
    async def create_sync_button(
        self, 
        interaction: discord.Interaction, 
        title: Optional[str] = None,
        description: Optional[str] = None,
        channel: Optional[discord.TextChannel] = None
    ):
        """Create a sync button embed"""
        target_channel = channel or interaction.channel
        
        # Create embed
        embed_title = title or "🔗 Account Synchronization"
        embed_description = description or (
            "Click the button below to sync your Discord account with your ozfortress profile.\n\n"
            "**Requirements:**\n"
            "• You must have an ozfortress account\n"
            "• Your Discord account must be linked in ozfortress Settings → Connections\n\n"
            "**Benefits:**\n"
            "• Automatic team captain role assignment\n"
            "• Access to team-specific channels and features"
        )
        
        embed = discord.Embed(
            title=embed_title,
            description=embed_description,
            color=discord.Color.blue()
        )
        embed.set_footer(text="Powered by Drawbridge")
        
        # Create view with sync button
        view = SyncButtonView(self)
        
        try:
            # Send the embed with button to the target channel
            await target_channel.send(embed=embed, view=view)
            
            # Respond to the command
            response_msg = f"Sync button created successfully in {target_channel.mention}"
            if target_channel != interaction.channel:
                await interaction.response.send_message(response_msg, ephemeral=True)
            else:
                await interaction.response.send_message(response_msg, ephemeral=True, delete_after=5)
            
            logger.info(f"Sync button created by {interaction.user} (ID: {interaction.user.id}) in {target_channel}")
            await self._channel_log(f"Sync button created by <@{interaction.user.id}> in {target_channel.mention}")
            
        except discord.Forbidden:
            await interaction.response.send_message(
                f"❌ I don't have permission to send messages in {target_channel.mention}",
                ephemeral=True
            )
        except Exception as e:
            logger.error(f"Error creating sync button: {e}")
            await interaction.response.send_message(
                "❌ An error occurred while creating the sync button.",
                ephemeral=True
            )


async def initialize(bot: discord_commands.Bot, db, cit, logger):
    await bot.add_cog(Sync(bot, db, cit, logger), guilds=[bot.get_guild(int(os.getenv('DISCORD_GUILD_ID')))])
