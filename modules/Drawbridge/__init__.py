"""
Drawbridge Helper Functions and Checks.
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

:copyright: (c) 2024-present ozfortress"""

__title__ = 'drawbridge'
__author__ = 'ozfortress'
__license__ = 'None'
__version__ = '0.0.1'
__copyright__ = 'Copyright 2024-present ozfortress'

__path__ = __import__('pkgutil').extend_path(__path__, __name__)

# import logging
from .checks import *
from .functions import *
from .logging import *
# from .commands import *
import os
import pkgutil

from modules.citadel import Citadel
from modules.database import Database
from logging import Logger
import discord
from discord.ext import commands as discord_commands
from discord.ext import tasks as discord_tasks

async def initialize(client: discord_commands.Bot, db : Database, cit : Citadel, logger : Logger):
    commands_path = os.path.join(os.path.dirname(__file__), 'commands')
    await client.add_cog(Logging(client, db, cit)) # Manually add the logging module.
    modules = {}
    for _, module_name, _ in pkgutil.iter_modules([commands_path]):
        logger.info(f'Loading module: {module_name} - {commands_path}')
        module = __import__(f'modules.Drawbridge.commands.{module_name}', fromlist=[module_name])
        modules[module_name] = module
        # module.Start(self.cmd_tree, self.db, self.cit)
    for module in modules.values():
        if hasattr(module, 'initialize'):
            # l
            await module.initialize(client, db, cit, logger)
    cmds = await client.tree.sync(guild=discord.Object(id=os.getenv('DISCORD_GUILD_ID')))
    logger.info(f'COMMANDS: {cmds}')
    for cmd in client.tree.walk_commands(guild=discord.Object(id=os.getenv('DISCORD_GUILD_ID'))):
        logger.info(f'DEBUG: {cmd.name} - {type(cmd)}')

# class Drawbridge():
#     def __init__(self, client: discord_commands.Bot, db : Database, cit : Citadel, logger : Logger):
#         self.client = client
#         self.db = db
#         self.cit = cit
#         self.logger = logger
#         self.modules = {}
#         # self.cmd_tree = discord.app_commands.CommandTree(client)
#         self.cmd_tree = self.client.tree

#         self.Checks = Checks
#         self.Functions = Functions(self.db, self.cit)
#         self.Logging = Logging(self.client, self.db)

#         @client.event
#         async def on_ready():
#             logger.info(f'Logged in as {client.user.name}#{client.user.discriminator} ({client.user.id})')
#             await self.load_all_commands()

#         @discord_tasks.loop(seconds=5)
#         async def check_commands():
#             await self.check_commands()

#     async def load_all_commands(self):
#         commands_path = os.path.join(os.path.dirname(__file__), 'commands')
#         for _, module_name, _ in pkgutil.iter_modules([commands_path]):
#             self.logger.info(f'Loading module: {module_name} - {commands_path}')
#             module = __import__(f'modules.Drawbridge.commands.{module_name}', fromlist=[module_name])
#             self.modules[module_name] = module
#             # module.Start(self.cmd_tree, self.db, self.cit)
#         for module in self.modules.values():
#             if hasattr(module, 'initialize'):
#                 await module.initialize(self)
#         await self.cmd_tree.sync(guild=discord.Object(id=os.getenv('DISCORD_GUILD_ID')))

#     async def check_commands(self):
#         self.logger.info('DEBUG - Checking commands')
#         for cmd in self.cmd_tree.walk_commands(guild=discord.Object(id=os.getenv('DISCORD_GUILD_ID'))):
#             self.logger.info(f'DEBUG: {cmd.name} - {type(cmd)}')


__all__ = ['Drawbridge', 'Checks', 'Functions']
