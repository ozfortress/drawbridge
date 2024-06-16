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

class Drawbridge:
    def __init__(self, client: discord.Client, db : Database, cit : Citadel, logger : Logger):
        self.client = client
        self.db = db
        self.cit = cit
        self.logger = logger
        self.modules = {}
        self.cmd_tree = discord.app_commands.CommandTree(client)

        self.Checks = Checks
        self.Functions = Functions(self.db, self.cit)
        self.Logging = Logging(self.client, self.db)

        @client.event
        async def on_ready():
            logger.info(f'Logged in as {client.user.name}#{client.user.discriminator} ({client.user.id})')
            await self.load_all_commands()

    async def load_all_commands(self):
        commands_path = os.path.join(os.path.dirname(__file__), 'commands')
        for _, module_name, _ in pkgutil.iter_modules([commands_path]):
            module = __import__(f'modules.Drawbridge.commands.{module_name}', fromlist=[module_name])
            self.modules[module_name] = module
            # module.Start(self.cmd_tree, self.db, self.cit)
        for module in self.modules.values():
            if hasattr(module, 'initialize'):
                module.initialize(self)
        await self.cmd_tree.sync(guild=discord.Object(id=os.getenv('DISCORD_GUILD_ID')))

__all__ = ['Drawbridge', 'Checks', 'Functions']
