import discord
from typing import List
from discord.ext import commands as discord_commands
# from discord import app_commands
import time
import os

class WarnedUser:
    def __init__(self, user:discord.Member, time:float, warned_for:str):
        self.user = user
        self.time = time
        self.warned_for = warned_for

class WarnedUsers(list):
    def __init__(self):
        self = []
    def add(self, user:discord.Member, time:float, warned_for:str):
        self.append(WarnedUser(user, time, warned_for))
    def remove(self, user:discord.Member):
        for warned in self:
            if warned.user == user:
                self.remove(warned)
    def get(self, user:discord.Member, warned_for:str):
        for warned in self:
            if warned.user == user and warned.warned_for == warned_for:
                return warned
        return None
class Checks:
    """
    All Checks used by Drawbridge."""
    def __init__(self):
        self.roles = {key.upper(): value for key, value in os.environ.items() if key.upper().startswith('ROLE_')}
        self.user_cooldowns = {}
        self.guild_cooldowns = {}
        self.warned_users = WarnedUsers()


    def _get_role_ids(self, *keywords: str) -> List[int]:
        """
        Returns a list of IDs of roles based on keywords.

        Parameters
        -----------
        *keywords : str
            Keywords to search for in role names. Case-insensitive.

        Returns
        --------
        List[int]
            List of role IDs.
        """
        keywords = [word.upper() for word in keywords]
        antikeywords = []
        for word in keywords:
            if word.startswith('!'):
                antikeywords.append(word[1:])
                keywords.remove(word)
        return [
            int(id) for key, id in self.roles.items()
            if any(word in key for word in keywords if word) and not any(word in key for word in antikeywords)
        ]

    def has_roles(self, *keywords: str):
        """
        Check if user has any of the roles based on keywords.

        Parameters
        -----------
        *keywords : str
            Keywords to search for in role names. Case-insensitive.
        """
        return discord.app_commands.checks.has_any_role(*self._get_role_ids(*keywords))

    def is_head(self):
        """
        Check if user has any Head Admin role.
        """
        return discord.app_commands.checks.has_any_role(*self._get_role_ids('Head'))

    def is_admin(self):
        """
        Check if user has any Admin role.
        """
        return discord.app_commands.checks.has_any_role(*self._get_role_ids('Admin'))

    def is_trial(self):
        """
        Check if user has any Trial Admin role.
        """
        return discord.app_commands.checks.has_any_role(*self._get_role_ids('Trial'))

    def is_developer(self):
        """
        Check if user has any Developer role.
        """
        return discord.app_commands.checks.has_any_role(*self._get_role_ids('Developer'))

    def is_caster(self):
        """
        Check if user has any Caster role.
        """
        return discord.app_commands.checks.has_any_role(*self._get_role_ids('Caster'))

    def is_staff(self):
        """
        Check if user has any Staff role.
        """
        return discord.app_commands.checks.has_any_role(*self._get_role_ids('Staff'))

    def is_director(self):
        """
        Check if user has Director role.
        """
        return discord.app_commands.checks.has_any_role(*self._get_role_ids('Director'))

    def is_approved_caster(self):
        """
        Check if user has Approved Caster role.
        """
        return discord.app_commands.checks.has_any_role(*self._get_role_ids('Approved', 'Caster'))

    def is_unapproved_caster(self):
        """
        Check if user has Unapproved Caster role.
        """
        return discord.app_commands.checks.has_any_role(*self._get_role_ids('Unapproved', 'Caster'))

    def is_bot(self):
        """
        Check if user has Bot role.
        """
        return discord.app_commands.checks.has_any_role(*self._get_role_ids('Bot'))

    def user_cooldown(self, timeout: int | float):
        async def predicate(ctx: discord.Interaction):
            now = time.time()
            if ctx.user.id in self.user_cooldowns:
                if self.user_cooldowns[ctx.user.id] > now:
                    self.user_cooldowns[ctx.user.id] = now + timeout
                    return True
                else:
                    raise discord_commands.CommandOnCooldown(timeout, self.user_cooldowns[ctx.user.id] - now, discord_commands.BucketType.user)
            else:
                self.user_cooldowns[ctx.user.id] = time.time() + timeout
                return True
        return discord_commands.check(predicate)

    def guild_cooldown(self, key, timeout: int | float):
        async def predicate(ctx: discord.Interaction):
            now = time.time()
            if not ctx.guild.id in self.guild_cooldowns:
                self.guild_cooldowns[ctx.guild.id] = {}
            if key in self.guild_cooldowns[ctx.guild.id]:
                if self.guild_cooldowns[ctx.guild.id][key] > now:
                    self.guild_cooldowns[ctx.guild.id][key] = now + timeout
                    return True
                else:
                    raise discord_commands.CommandOnCooldown(timeout, self.guild_cooldowns[ctx.guild.id][key] - now, discord_commands.BucketType.guild)
            else:
                self.guild_cooldowns[ctx.guild.id][key] = time.time() + timeout
                return True
        return discord_commands.check(predicate)

    def has_been_warned(self, warned_for:str, warning_message:str):
        """
        Check if the user has been warned about the danger of a command.
        """
        async def predicate(ctx: discord.Interaction):
            warned = self.warned_users.get(ctx.user, warned_for)
            if warned is None or warned.time < time.time() - 60 * 5:
                if warning_message:
                    await ctx.response.send_message(warning_message, delete_after=5*60, ephemeral=True)
                else:
                    await ctx.response.send_message(f"This command has a safety mechanism. Please rerun the command within 5 minutes to execute.\nTake this opportunity to check that the command and arguments are correct.", delete_after=5*60, ephemeral=True)
                self.warned_users.add(ctx.user, time.time(), warned_for)
                return False
            return True
        return discord_commands.check(predicate)
