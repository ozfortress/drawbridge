if __name__ != '__main__':
    raise ImportError('This is not a module. Please run app.py instead.')

import logging
import os
from dotenv import load_dotenv
import discord
from discord import app_commands
from modules import citadel
from modules import database
from modules import Drawbridge


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
    Drawbridge.logging.Logging(client, db) # TODO: this... better.
    import modules.Drawbridge.commands.get_teams as get_teams
    get_teams.GetTeams(cmds, db, cit) # TODO: this... better.
    synced_commands = await cmds.sync(guild=discord.Object(id=os.getenv('DISCORD_GUILD_ID')))
    logger.info(f'Synced {len(synced_commands)} commands.')
    for synced_command in synced_commands:
        logger.debug(f'Synced command: {synced_command.name}')


if __name__ == '__main__':
    main()

# Path: app.py
