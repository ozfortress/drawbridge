import discord
from . import functions as Drawbridge
from . import citadel as Citadel
import modules.database as database
from discord.ext import commands as discord_commands
import os
import aiohttp

class LogsTFEmbed(discord_commands.Cog):
    def __init__ (self,client : discord_commands.Bot, db : database.Database, cit : Citadel.Citadel):
        self.db = db
        self.client = client
        self.cit = cit
        self.functions = Drawbridge.Functions(db, cit)
        self.antispam = {}

    @discord_commands.Cog.listener()
    async def on_message(self,message : discord.Message):
        # Ignore message if it doesnt contain a Logs.tf link
        if 'logs.tf/' not in message.content:
            return
        # reject other bots
        if message.author.bot:
            return

        # Anti-spam: Reject if user has posted a Logs.tf link in the last 30 seconds
        if message.author.id in self.antispam:
            if self.antispam[message.author.id] + 20 > message.created_at.timestamp():
                return

        valid = self.validateLogsTFURL(message)
        if valid :
            embed = await self.generateEmbed(valid)
            if embed:
                await message.channel.send(embed=embed)
            else:
                return
        else:
            return


        self.antispam[message.author.id] = message.created_at.timestamp()

    def validateLogsTFURL(self, message : discord.Message):
        # validate
        # we need the number after the first /, and before any #.
        parts = message.content.split('logs.tf/')
        if len(parts) < 2:
            return False
        # we need the number after the first /, and before any #. The # may not be present
        id = parts[1].split('/')[0]
        id = id.split('#')[0]
        if not id.isdigit():
            return False
        id = int(id)
        return id

    def convertSecondsIntoHumanReadable(self, seconds : int):
        minutes, sec = divmod(seconds, 60)
        hours, minutes = divmod(minutes, 60)
        if hours > 0:
            return f"{hours}h {minutes}m {sec}s"
        elif minutes > 0:
            return f"{minutes}m {sec}s"
        else:
            return f"{sec}s"

    async def generateEmbed(self, id : int):
        # fetch from logs.tf/api/v1/log/id

        url = f'https://logs.tf/api/v1/log/{id}'


        async with aiohttp.ClientSession() as session:
            async with session.get(url) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    redscore = data['teams']['Red']['score']
                    bluescore = data['teams']['Blue']['score']
                    if not data['success']:
                        raise Exception(f"Logs.tf API request failed: {data.get('error', 'Unknown error (no success field)')}")
                    if not data['version'] == 3:
                        raise Exception(f"Unsupported Logs.tf API version (expected 3, got {data['version']})")
                    embed = discord.Embed(
                        title=f"logs.tf/{id} - {data['info']['title']}",
                        description=f"Map: {data['info']['map']}\nDuration: {self.convertSecondsIntoHumanReadable(data['length'])}\nScore: {bluescore} - {redscore}",
                        timestamp= data['info']['date'],
                        color=(bluescore > redscore and discord.Color.from_str("0x3498db") or redscore > bluescore and discord.Color.from_str("0xe74c3c") or discord.Color.from_str("0x95a5a6")),
                        url=f"https://logs.tf/{id}"
                    )

                    return embed
                else:
                    # Handle error response
                    return None

