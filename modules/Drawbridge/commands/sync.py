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

    async def _channel_log(self, message: str):
        await self.log_channel.send(message)

    async def _sync_user(self, target: discord.User, interaction: discord.Interaction):
        src = interaction.user
        about_self = target.id == src.id
        forced_log = f" (Forced by <@{src.id}>)" if not about_self else ""
        user: Optional[citadel.Citadel.User] = self.cit.getUserByDiscordID(target.id)
        name = target.name + "'s" if not about_self else "Your"
        
        if user is None:
            extra_intruction = " Be sure to link it with this Discord account at [ozfortress.com](https://ozfortress.com) in `Settings → Connections`." if about_self else ""
            await interaction.response.send_message(content=f"{name} Discord account is not linked to the ozfortress website.{extra_intruction}", ephemeral=True)
            await self._channel_log(f"<@{target.id}> tried to link their Discord but did not have a linked ozfortress account.{forced_log}")
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
                log_message = f"<@{target.id}> updated their ozfortress account to {citadel_acc_link}.{forced_log}"
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
                log_message = f"<@{target.id}> linked their ozfortress account to {citadel_acc_link}.{forced_log}"
            
            # Now assign roles based on team captaincy
            roles_assigned = await self._assign_captain_roles(user, target)
            
            if roles_assigned:
                status_message += f"\n\nRoles assigned: {', '.join(roles_assigned)}"
                log_message += f" Roles assigned: {', '.join(roles_assigned)}"
                
            await interaction.response.send_message(content=status_message, ephemeral=True)
            await self._channel_log(log_message)
    
    async def _assign_captain_roles(self, citadel_user: citadel.Citadel.User, discord_user: discord.User) -> list[str]:
        """
        Assign team captain roles to a user based on their team captaincy.
        Returns a list of role names that were assigned.
        """
        assigned_roles = []
        
        try:
            guild = self.bot.get_guild(int(os.getenv('DISCORD_GUILD_ID')))
            member = guild.get_member(discord_user.id) if guild else None
            
            if not member:
                logger.warning(f"User {citadel_user.name} (Discord ID: {discord_user.id}) is not in the server")
                return assigned_roles
            
            # Get all active leagues we're tracking
            all_leagues = self.db.leagues.get_all()
            
            for league in all_leagues:
                league_id = league['league_id']
                
                # Get all divisions and teams for this league
                divisions = self.db.divisions.get_by_league(league_id)
                teams = self.db.teams.get_by_league(league_id)
                
                for team_record in teams:
                    team_id = team_record['team_id']
                    
                    try:
                        # Get team details from Citadel
                        team: citadel.Citadel.Team = self.cit.getTeam(team_id)
                        
                        # Check if this user is a captain of this team
                        for player in team.players:
                            if player['id'] == citadel_user.id and player['is_captain']:
                                logger.info(f"User {citadel_user.name} is captain of team {team.name} (ID: {team_id})")
                                
                                # Assign team role
                                team_role_id = team_record.get('role_id')
                                if team_role_id:
                                    team_role = guild.get_role(team_role_id)
                                    if team_role and team_role not in member.roles:
                                        await member.add_roles(team_role, reason="Drawbridge sync: Team captain role")
                                        assigned_roles.append(f"Team: {team_role.name}")
                                        logger.info(f"Assigned team role {team_role.name} to {citadel_user.name}")
                                
                                # Assign division role
                                # Find the division this team belongs to
                                for division in divisions:
                                    if division['division_id'] == team_record.get('division_id'):
                                        div_role_id = division.get('role_id')
                                        if div_role_id:
                                            div_role = guild.get_role(div_role_id)
                                            if div_role and div_role not in member.roles:
                                                await member.add_roles(div_role, reason="Drawbridge sync: Division captain role")
                                                assigned_roles.append(f"Division: {div_role.name}")
                                                logger.info(f"Assigned division role {div_role.name} to {citadel_user.name}")
                                        break
                                
                    except Exception as e:
                        logger.error(f"Failed to process team {team_id} for role assignment: {e}")
                        continue
        
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
        await self._sync_user(target, interaction)


async def initialize(bot: discord_commands.Bot, db, cit, logger):
    await bot.add_cog(Sync(bot, db, cit, logger), guilds=[bot.get_guild(int(os.getenv('DISCORD_GUILD_ID')))])
