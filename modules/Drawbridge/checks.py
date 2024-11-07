import discord
from typing import List
from discord.ext import commands as discord_commands
# from discord import app_commands
import time
import os
class Checks:
    """
    All Checks used by Drawbridge."""
    def __init__(self):
        self.roles = {key.upper(): value for key, value in os.environ.items() if key.upper().startswith('ROLE_')}
        self.user_cooldowns = {}
        self.guild_cooldowns = {}

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

