import discord
from discord.ext import commands as discord_commands
# from discord import app_commands
import time
class Checks:
    """
    All Checks used by Drawbridge."""
    def __init__(self):
        self.roles = {
            'Director' : '1243181553522053191', # League Director
            '6s Head' : '1243184095878709249', # 6s Head Admin
            'HL Head' : '1243184165072011368', # HL Head Admin
            '6s Admin' : '1243183240471253134', # 6s Admin
            'HL Admin' : '1243183285824126976', # HL Admin
            'Trial Admin' : '1243197012443267113', # Trial Admin
            'Developers' : '1243183754625814599', # Developers
            'Approved Casters' : '1243192943548829726', # Approved Casting
            'Unapproved Casters' : '1243193009768497334', # Unapproved Casting
            'Captains Bot': '1248508402275975169', # Captains Bot
            'Staff': '1243181493598031934' # Staff role for all staff members
        }
        self.user_cooldowns = {}
        self.guild_cooldowns = {}

    def director_only(self):
        return discord.app_commands.checks.has_any_role(self.roles['Director'])

    def heads_only(self):
        return discord.app_commands.checks.has_any_role(self.roles['6s Head'], self.roles['HL Head'], self.roles['Director'], self.roles['Developers'])

    def admin_only(self):
        return discord.app_commands.checks.has_any_role(self.roles['6s Admin'], self.roles['HL Admin'], self.roles['6s Head'], self.roles['HL Head'], self.roles['Director'], self.roles['Developers'])

    def trials_only(self):
        return discord.app_commands.checks.has_any_role(self.roles['Trial Admin'], self.roles['6s Admin'], self.roles['HL Admin'], self.roles['6s Head'], self.roles['HL Head'], self.roles['Director'],  self.roles['Developers'])

    def dev_only(self):
        return discord.app_commands.checks.has_any_role(self.roles['Developers'], self.roles['Director'])

    def casters_only(self):
        return discord.app_commands.checks.has_any_role(self.roles['Approved Casters'], self.roles['Unapproved Casters'], self.roles['Director'],  self.roles['Developers'], self.roles['Staff'])

    def staff_only(self):
        return discord.app_commands.checks.has_any_role(self.roles['Staff'], self.roles['Director'], self.roles['Developers'])

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

#del discord, discord_commands, time
