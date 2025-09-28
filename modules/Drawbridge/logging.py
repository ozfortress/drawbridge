import functools
import logging
import discord
from . import functions as Drawbridge
from . import citadel as Citadel
import modules.database as database
import time
import threading
import os
from discord.ext import commands as discord_commands

class Logging(discord_commands.Cog):
    def __init__(self, client : discord_commands.Bot, db : database.Database, cit):
        self.db = db
        self.client = client
        self.logger = logging.Logger('Drawbridge.Logging')
        self.cit = cit
        self.teamchannel_cache={
            'channels' : {
            },
            'refreshAfter': 0 # timestamp representing the next time the cache should be refreshed
        }
        self.functions = Drawbridge.Functions(db, cit)
        
        
    

    @discord_commands.Cog.listener()
    async def on_message(self,message : discord.Message):
        match = self.db.matches.get_by_channel_id(message.channel.id)
        if match:
            self.functions.generate_log(message, False, match['match_id'], None, "CREATE")
            return

        team = self.db.teams.get_by_channel_id(message.channel.id)
        if team:
            self.functions.generate_log(message, True, None, team['team_id'], "CREATE")

        #else:
            # Verify cache is up to date
            # if self.teamchannel_cache['refreshAfter'] < time.time():
            #     channels = db.get_team_channels()
            #     for channel in channels:
            #         self.teamchannel_cache['channels'][channel['team_channel']] = channel['team_id']
            #     self.teamchannel_cache['refreshAfter'] = time.time() + 3600*24
            # if message.channel.id in self.teamchannel_cache['channels']:
            #     Drawbridge.Functions.generate_log(message, True, 0, "CREATE")

    @discord_commands.Cog.listener()
    async def on_message_edit(self, before : discord.Message, after : discord.Message):
        match = self.db.matches.get_by_channel_id(after.channel.id)
        if match:
            self.functions.generate_log(before, False, match['match_id'], None, "EDIT", after)

        team = self.db.teams.get_by_channel_id(before.channel.id)
        if team:
            self.functions.generate_log(before, True, None, team['team_id'], "EDIT", after)
        #else:
            # Verify cache is up to date
            # if self.teamchannel_cache['refreshAfter'] < time.time():
            #     channels = db.get_team_channels()
            #     for channel in channels:
            #         self.teamchannel_cache['channels'][channel['team_channel']] = channel['team_id']
            #     self.teamchannel_cache['refreshAfter'] = time.time() + 3600*24
            # if after.channel.id in self.teamchannel_cache['channels']:
            #     Drawbridge.Functions.generate_log(before, True, 0, "EDIT", after)

    @discord_commands.Cog.listener()
    async def on_message_delete(self, message : discord.Message):
        # WARNING - UNRELIABLE - MIGHT MISS OLD MSGS if they arent in cache.
        match = self.db.matches.get_by_channel_id(message.channel.id)
        if match:
            self.functions.generate_log(message, False, match['match_id'], None, "DELETE")

        team = self.db.teams.get_by_channel_id(message.channel.id)
        if team:
            self.functions.generate_log(message, True, None, team['team_id'], "DELETE")
        #else:
            # Verify cache is up to date
            # if self.teamchannel_cache['refreshAfter'] < time.time():
            #     channels = db.get_team_channels()
            #     for channel in channels:
            #         self.teamchannel_cache['channels'][channel['team_channel']] = channel['team_id']
            #     self.teamchannel_cache['refreshAfter'] = time.time() + 3600*24
            # if message.channel.id in self.teamchannel_cache['channels']:
            #     Drawbridge.Functions.generate_log(message, True, 0, "DELETE")

    async def archive_match(self, match_id: int, ctx: discord.Interaction, silent: bool = False):
        """
        Archives a match, removing it from the active matches list. Performs this action in a new thread to prevent blocking the main thread.

        Parameters
        -----------
        match_id: int
            The ID of the match to archive.
        ctx: discord.Interaction
            The context of the command that triggered the match archiving."""
        await self._archive_match(match_id, ctx, silent)

    async def _archive_match(self, match_id: int, ctx: discord.Interaction, ehphemeral: bool = False):
        """
        Generates an archive of a match"""
        # await ctx.response.send_message(content=f'Generating logs for match {match_id}, please wait...', ephemeral=ehphemeral)
        logs = self.db.logs.get_by_match_id(match_id)
        log_path = f'logs/match_{match_id}.log'
        iteration = 1
        while os.path.exists(log_path):
            log_path = f'logs/match_{match_id}_{iteration}.log'
            iteration += 1
        try:
            with open(log_path, 'w') as f:
                f.write(f'Logs for match {match_id}\n')
                f.write(f'Archived at {time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())}\n')
                f.write(f'Logs generated by Drawbridge v{Drawbridge.__version__} for {ctx.user.name}\n\n')
                f.write(f'{"-"*50}\n\n')
                
                if logs:
                    for log in logs:
                        f.write(f'[ {log["log_timestamp"]} ] {log["user_nick"] or log["user_name"]} <@{log["user_id"]}> ({log["user_name"]}) - {log["log_type"]}\n')
                        if log['log_type'] == 'CREATE':
                            f.write(f'    {log["message_content"]}\n')
                        elif log['log_type'] == 'EDIT':
                            f.write(f'    OLD: {log["message_content"]} ->\n    NEW: {log["message_additionals"]}\n')
                        elif log['log_type'] == 'DELETE':
                            f.write(f'    {log["message_content"]}\n')
                        if log['message_additionals']:
                            f.write(f'        [[ Attachments: {log["message_additionals"]} ]]\n')
                        f.write('\n')
                else:
                    f.write('No logs found for this match.\n')
            if logs:
                await ctx.response.send_message(content=f'Logs have been generated. They\'ve been attached to this message.', files=[discord.File(log_path)])
            else:
                await ctx.response.send_message(content=f'No logs found for this match. Log file has been generated.', files=[discord.File(log_path)])

        except Exception as e:
            self.logger.error(f'An error occurred while generating {match_id} logs: {e}')
            await ctx.response.send_message(content=f'An error occurred while generating the logs: {e}', ephemeral=True)




#del discord, Drawbridge, database, time, threading
