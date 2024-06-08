import discord
import Drawbridge
import modules.database as database
import time

class Logging():
    def __init__(self, client : discord.Client, db : database.Database):
        self.teamchannel_cache={
            'channels' : {
            },
            'refreshAfter': 0 # timestamp representing the next time the cache should be refreshed
        }
        @client.event
        async def on_message(message : discord.Message):
            match_id = db.get_match_id_of_channel(message.channel.id)
            if match_id:
                Drawbridge.Functions.generate_log(message, False, match_id, "CREATE")
            else:
                # Verify cache is up to date
                if self.teamchannel_cache['refreshAfter'] < time.time():
                    channels = db.get_team_channels()
                    for channel in channels:
                        self.teamchannel_cache['channels'][channel['team_channel']] = channel['team_id']
                    self.teamchannel_cache['refreshAfter'] = time.time() + 3600*24
                if message.channel.id in self.teamchannel_cache['channels']:
                    Drawbridge.Functions.generate_log(message, True, 0, "CREATE")

        @client.event
        async def on_message_edit(before : discord.Message, after : discord.Message):
            match_id = db.get_match_id_of_channel(after.channel.id)
            if match_id:
                Drawbridge.Functions.generate_log(before, False, match_id, "EDIT", after)
            else:
                # Verify cache is up to date
                if self.teamchannel_cache['refreshAfter'] < time.time():
                    channels = db.get_team_channels()
                    for channel in channels:
                        self.teamchannel_cache['channels'][channel['team_channel']] = channel['team_id']
                    self.teamchannel_cache['refreshAfter'] = time.time() + 3600*24
                if after.channel.id in self.teamchannel_cache['channels']:
                    Drawbridge.Functions.generate_log(before, True, 0, "EDIT", after)

        @client.event
        async def on_message_delete(message : discord.Message):
            # WARNING - UNRELIABLE - MIGHT MISS OLD MSGS if they arent in cache.
            match_id = db.get_match_id_of_channel(message.channel.id)
            if match_id:
                Drawbridge.Functions.generate_log(message, False, match_id, "DELETE")
            else:
                # Verify cache is up to date
                if self.teamchannel_cache['refreshAfter'] < time.time():
                    channels = db.get_team_channels()
                    for channel in channels:
                        self.teamchannel_cache['channels'][channel['team_channel']] = channel['team_id']
                    self.teamchannel_cache['refreshAfter'] = time.time() + 3600*24
                if message.channel.id in self.teamchannel_cache['channels']:
                    Drawbridge.Functions.generate_log(message, True, 0, "DELETE")
