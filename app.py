if __name__ != '__main__':
    raise ImportError('This is not a module. Please run app.py instead.')

import logging
import os
import sys
from pathlib import Path
from dotenv import load_dotenv
import discord
from discord.ext import commands as discord_commands
from discord.ext import tasks as discord_tasks
from modules import citadel
from modules import database
from modules import Drawbridge
from modules.logging_config import get_logger, DiscordEventLogger
from modules.health_monitor import initialize_health_monitor, get_health_monitor
import subprocess
import datetime
import socket
import asyncio
import traceback


load_dotenv()

# Initialize centralized logging
logger = get_logger('drawbridge.main')
discord_event_logger = DiscordEventLogger()
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
cit = citadel.Citadel(os.getenv('CITADEL_API_KEY'), baseURL=os.getenv('CITADEL_HOST'))
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
    # The logging system is already configured by logging_config.py
    logger.info(f'Starting OZF Drawbridge v{VERSION}...')
    logger.info('OZF Drawbridge has started.')
    
    # Always start both bot and web server
    logger.info('Starting both Discord bot and web server...')
    import asyncio
    
    async def run_both():
        # Start bot task
        bot_task = asyncio.create_task(client.start(os.getenv('DISCORD_TOKEN')))
        
        # Start web server task
        try:
            # Add web directory to Python path
            web_dir = Path(__file__).parent / 'web'
            if str(web_dir) not in sys.path:
                sys.path.insert(0, str(web_dir))
            
            # Import the web server module
            import simple_web_server
            web_app = getattr(simple_web_server, 'app', None)
            set_shared_database = getattr(simple_web_server, 'set_shared_database', None)
            
            # Share the database connection with the web server if available
            if callable(set_shared_database):
                try:
                    set_shared_database(db)
                except Exception as e:
                    logger.warning(f'Failed to set shared database for web server: {e}')
            
            host = os.getenv('WEB_HOST', '0.0.0.0')
            port = int(os.getenv('WEB_PORT', 8080))
            
            # Only start the web server if the module exposes an async run_task API
            if web_app is not None and hasattr(web_app, 'run_task'):
                try:
                    web_task = asyncio.create_task(web_app.run_task(host=host, port=port))
                    logger.info(f'Web server will start on {host}:{port} with shared database')
                    
                    # Wait for both to complete (or one to fail)
                    _, pending = await asyncio.wait(
                        [bot_task, web_task],
                        return_when=asyncio.FIRST_COMPLETED
                    )
                    
                    # Cancel any remaining tasks
                    for task in pending:
                        task.cancel()
                except Exception as e:
                    # Catch runtime errors from the web server startup (e.g. framework attribute issues)
                    logger.error(f'Web server task failed to start: {e}')
                    await bot_task
            else:
                logger.warning('simple_web_server.app does not expose run_task; skipping web server startup')
                # Just run the bot if the web server exposes no run_task
                await bot_task
                
        except ImportError as e:
            logger.warning(f'Web server not available: {e}')
            # Just run the bot if web server fails to import
            await bot_task
        except Exception as e:
            logger.error(f'Error starting web server: {e}')
            # Just run the bot if web server fails to start
            await bot_task
    
    asyncio.run(run_both())

@client.event
async def on_ready():
    logger.info(f'Logged in as {client.user.name}#{client.user.discriminator} ({client.user.id})')
    discord_event_logger.log_event('bot_ready', f'Bot logged in as {client.user.name}')
    
    # Initialize health monitoring
    health_monitor = initialize_health_monitor(client, db)
    health_monitor.start_monitoring()
    logger.info('Health monitoring system initialized')
    
    await Drawbridge.initialize(client, db, cit, logger)
    
    # Initialize web IPC handler if available
    try:
        from modules.Drawbridge.web_ipc import WebIPCHandler
        await client.add_cog(WebIPCHandler(client))
        logger.info('Web IPC handler loaded successfully')
    except ImportError as e:
        logger.warning(f'Web IPC handler not available (missing dependencies): {e}')
    except Exception as e:
        logger.error(f'Failed to load Web IPC handler: {e}')

    botmisc= client.get_channel(int(os.getenv('ANNOUNCE_CHANNEL')))
    def get_latest_commit():
        try:
            latest_commit = subprocess.check_output(['git', 'rev-parse', 'HEAD']).decode().strip()
            return latest_commit
        except subprocess.CalledProcessError as e:
            logger.error(f'Failed to get latest commit: {e}')
            return None

    latest_commit = get_latest_commit()
    if latest_commit:
        try:
            commit_info = subprocess.check_output(['git', 'show', '-s', latest_commit]).decode().strip().split('\n')
            commit_author = commit_info[1].split(':')[1].strip()
            commit_message = '\n'.join(commit_info[4:]).strip()
            commit_date = commit_info[2].split('Date:')[1].strip()
            now = int(datetime.datetime.now().timestamp())
            
            logger.info(f'Bot started with commit {latest_commit[:6]} by {commit_author}')
            await botmisc.send(f'# Bot has been started\n- time: <t:{now}>\n- `{latest_commit[:6]}` - `{commit_date}`\n- author: {commit_author}\n```\n{commit_message}```')
        except Exception as e:
            logger.error(f'Failed to process commit info: {e}')
    
    healthstatus['status'] = b"OK"
    
    # Update health metrics
    health_monitor = get_health_monitor()
    if health_monitor:
        health_monitor.update_metric('bot_ready', True)
        health_monitor.update_heartbeat()
    
    logger.info('Bot initialization completed successfully')


# Catch any error that occurs during the on_ready event
@client.event
async def on_error(event, *args, **kwargs):
    logger.error(f'Error in event {event}: {args} {kwargs}', exc_info=True)
    
    # Update health metrics to indicate an error occurred
    health_monitor = get_health_monitor()
    if health_monitor:
        health_monitor.consecutive_failures += 1
        
    # None of the next code may work, so we need to catch any error that occurs here
    # and log it to the console
    try:
        botmisc= client.get_channel(int(os.getenv('ANNOUNCE_CHANNEL')))
        tb_str = ''.join(traceback.format_exception(None, args[0], args[0].__traceback__))
        await botmisc.send(f'# Unhandled Error\n```\n{tb_str}\n```')
        # await botmisc.send(f'# Unhandled Error\n in event {event}: \n args: {args} \n kwargs: {kwargs}')
    except Exception as e:
        logger.error(f'Error in on_error: {e}', exc_info=True)

@client.event
async def on_interaction(interaction):
    """Track interactions for health monitoring."""
    health_monitor = get_health_monitor()
    if health_monitor:
        health_monitor.update_metric('last_command_time', datetime.datetime.now())
        health_monitor.update_heartbeat()

@discord_tasks.loop(seconds=5)
async def check_commands():
    logger.info('DEBUG - Checking commands')
    for cmd in client.tree.walk_commands(guild=discord.Object(id=os.getenv('DISCORD_GUILD_ID'))):
        logger.info(f'DEBUG: {cmd.name} - {type(cmd)}')


if __name__ == '__main__':
    main()

# Path: app.py
