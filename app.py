if __name__ != '__main__':
    raise ImportError('This is not a module. Please run app.py instead.')

import logging
import os
from dotenv import load_dotenv
import discord
from discord.ext import commands as discord_commands
from discord.ext import tasks as discord_tasks
from modules import citadel
from modules import database
from modules import Drawbridge
import subprocess
import datetime
import socket
import asyncio


load_dotenv()

if not os.path.exists('logs'):
    os.makedirs('logs')
logger = logging.getLogger(__name__)
VERSION = '1.0.0'

intents = discord.Intents.all() # TODO: Change this to only the intents we need

client = discord_commands.Bot(".db ", intents=intents)
# cmds = discord.app_commands.CommandTree(client)

db = database.Database( conn_params={
    "database": os.getenv('DB_DATABASE'),
    "user": os.getenv('DB_USER'),
    "password": os.getenv('DB_PASS'),
    "host": os.getenv('DB_HOST'),
    "port": int(os.getenv('DB_PORT'))
})
cit = citadel.Citadel(os.getenv('CITADEL_API_KEY'))
socket_path = "/tmp/drawbridge.sock"
healthstatus={
    'status': b"NOT OK"
}

async def healthcheck():
    if os.path.exists(socket_path):
        os.remove(socket_path)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(socket_path)
    server.listen(1)

    while True:
        conn, _ = server.accept()
        try:
            data = conn.recv(1024).decode()
            if data.strip() == 'ping':
                conn.sendall(healthstatus['status'])
            else:
                conn.sendall(b"ERROR")
        except Exception as e:
            conn.sendall(b"ERROR")
            logger.error(f'Healthcheck error: {e}')
        finally:
            conn.close()


def main():
    logging.basicConfig(filename='logs/drawbridge.log', level='DEBUG', format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging._nameToLevel[os.getenv('LOG_LEVEL', 'INFO')])
    console_handler.setFormatter(logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s'))
    logger.addHandler(console_handler)
    logger.info(f'Starting OZF Drawbridge v{VERSION}...')
    # checkPackages()
    logger.info('OZF Drawbridge has started.')
    # Drawbridge.Drawbridge(client, db, cit, logger)
    client.run(os.getenv('DISCORD_TOKEN'))

@client.event
async def on_ready():
    logger.info(f'Logged in as {client.user.name}#{client.user.discriminator} ({client.user.id})')
    # await Drawbridge.load_all_commands(
    await Drawbridge.initialize(client, db, cit, logger)

    botmisc= client.get_channel(int(os.getenv('ANNOUNCE_CHANNEL')))
    def get_latest_commit():
        try:
            latest_commit = subprocess.check_output(['git', 'rev-parse', 'HEAD']).decode().strip()
            return latest_commit
        except subprocess.CalledProcessError:
            return None

    latest_commit = get_latest_commit()
    commit_info = subprocess.check_output(['git', 'show', '-s', latest_commit]).decode().strip().split('\n')
    commit_author = commit_info[1].split(':')[1].strip()
    commit_message = '\n'.join(commit_info[4:]).strip()
    commit_date = commit_info[2].split('Date:')[1].strip()
    now = int(datetime.datetime.now().timestamp())
    if latest_commit:
        await botmisc.send(f'# Bot has been started\n- time: <t:{now}>\n- `{latest_commit[:6]}` - `{commit_date}` `\n- author: {commit_author}\n```\n{commit_message}```')
    #Drawbridge.Logging(client, db, cit)
    healthstatus['status'] = b"OK"
    # client.loop.create_task(healthcheck())

@discord_tasks.loop(seconds=5)
async def check_commands():
    logger.info('DEBUG - Checking commands')
    for cmd in client.tree.walk_commands(guild=discord.Object(id=os.getenv('DISCORD_GUILD_ID'))):
        logger.info(f'DEBUG: {cmd.name} - {type(cmd)}')


if __name__ == '__main__':
    main()

# Path: app.py
