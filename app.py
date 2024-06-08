if __name__ != '__main__':
    raise ImportError('This is not a module. Please run app.py instead.')

import logging
import os
from dotenv import load_dotenv
import time
import discord
from discord.ext import commands
from discord import app_commands
from modules import citadel
from modules import database
from modules import Drawbridge
import json


load_dotenv()

if not os.path.exists('logs'):
    os.makedirs('logs')
logger = logging.getLogger(__name__)
VERSION = '0.0.1'

intents = discord.Intents.all() # TODO: Change this to only the intents we need

client = discord.Client(intents=intents)
cmds = app_commands.CommandTree(client)

db = database.Database( conn_params={
    "database": os.getenv('DB_DATABASE'),
    "user": os.getenv('DB_USER'),
    "password": os.getenv('DB_PASS'),
    "host": os.getenv('DB_HOST'),
    "port": int(os.getenv('DB_PORT'))
})
cit = citadel.Citadel(os.getenv('CITADEL_API_KEY'))
teamchannel_cache={
    'channels' : {
    },
    'refreshAfter': 0 # timestamp representing the next time the cache should be refreshed
}

def main():
    logging.basicConfig(filename='logs/drawbridge.log', level='DEBUG', format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging._nameToLevel[os.getenv('LOG_LEVEL', 'INFO')])
    console_handler.setFormatter(logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s'))
    logger.addHandler(console_handler)
    logger.info(f'Starting OZF Drawbridge v{VERSION}...')
    # checkPackages()
    logger.info('OZF Drawbridge has started.')
    client.run(os.getenv('DISCORD_TOKEN'))

@client.event
async def on_ready():
    logger.info(f'Logged in as {client.user.name}#{client.user.discriminator} ({client.user.id})')
    logger.info(f'Cmds: {cmds.get_commands()}')
    synced_commands = await cmds.sync(guild=discord.Object(id=os.getenv('DISCORD_GUILD_ID')))
    logger.info(f'Synced {len(synced_commands)} commands.')
    for synced_command in synced_commands:
        logger.debug(f'Synced command: {synced_command.name}')



@client.event
async def on_message(message : discord.Message):
    match_id = db.get_match_id_of_channel(message.channel.id)
    if match_id:
        Drawbridge.Functions.generate_log(message, False, match_id, "CREATE")
    else:
        # Verify cache is up to date
        if teamchannel_cache['refreshAfter'] < time.time():
            channels = db.get_team_channels()
            for channel in channels:
                teamchannel_cache['channels'][channel['team_channel']] = channel['team_id']
            teamchannel_cache['refreshAfter'] = time.time() + 3600*24
        if message.channel.id in teamchannel_cache['channels']:
            Drawbridge.Functions.generate_log(message, True, 0, "CREATE")

@client.event
async def on_message_edit(before : discord.Message, after : discord.Message):
    match_id = db.get_match_id_of_channel(after.channel.id)
    if match_id:
        Drawbridge.Functions.generate_log(before, False, match_id, "EDIT", after)
    else:
        # Verify cache is up to date
        if teamchannel_cache['refreshAfter'] < time.time():
            channels = db.get_team_channels()
            for channel in channels:
                teamchannel_cache['channels'][channel['team_channel']] = channel['team_id']
            teamchannel_cache['refreshAfter'] = time.time() + 3600*24
        if after.channel.id in teamchannel_cache['channels']:
            Drawbridge.Functions.generate_log(before, True, 0, "EDIT", after)

@client.event
async def on_message_delete(message : discord.Message):
    # WARNING - UNRELIABLE - MIGHT MISS OLD MSGS if they arent in cache.
    match_id = db.get_match_id_of_channel(message.channel.id)
    if match_id:
        Drawbridge.Functions.generate_log(message, False, match_id, "DELETE")
    else:
        # Verify cache is up to date
        if teamchannel_cache['refreshAfter'] < time.time():
            channels = db.get_team_channels()
            for channel in channels:
                teamchannel_cache['channels'][channel['team_channel']] = channel['team_id']
            teamchannel_cache['refreshAfter'] = time.time() + 3600*24
        if message.channel.id in teamchannel_cache['channels']:
            Drawbridge.Functions.generate_log(message, True, 0, "DELETE")

if __name__ == '__main__':
    main()

# Path: app.py
