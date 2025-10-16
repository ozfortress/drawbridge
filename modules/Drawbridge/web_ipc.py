"""
Discord bot IPC handler for web server requests
Add this to your main bot file or as a separate cog
"""

import asyncio
import json
import logging
from typing import Dict, Any, Optional
try:
    import redis.asyncio as aioredis
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False
    aioredis = None
from discord.ext import commands as discord_commands, tasks
from modules.logging_config import get_logger

logger = get_logger('drawbridge.ipc', 'ipc.log')

class WebIPCHandler(discord_commands.Cog):
    """Handles Inter-Process Communication with the web server"""
    
    def __init__(self, bot: discord_commands.Bot):
        self.bot = bot
        self.redis = None
        self.request_processor.start()
        
    async def cog_load(self):
        """Initialize Redis connection when cog loads"""
        if not REDIS_AVAILABLE:
            logger.info("Redis not available - IPC disabled")
            return
            
        try:
            import os
            self.redis = aioredis.from_url(
                os.getenv('REDIS_URL', 'redis://localhost:6379'),
                decode_responses=True
            )
            # Set environment-specific prefix for Redis keys
            self.redis_prefix = os.getenv('REDIS_PREFIX', 'drawbridge')
            # Test connection
            await self.redis.ping()
            logger.info("Redis IPC connection established")
        except Exception as e:
            logger.warning(f"Redis not available for IPC: {e}")
            self.redis = None
    
    async def cog_unload(self):
        """Cleanup when cog unloads"""
        self.request_processor.cancel()
        if self.redis:
            await self.redis.close()
    
    @tasks.loop(seconds=0.1)  # Check for requests every 100ms
    async def request_processor(self):
        """Process incoming requests from web server"""
        if not self.redis:
            return
            
        try:
            # Check for new requests (non-blocking)
            request_data = await self.redis.brpop(f'{self.redis_prefix}:discord_requests', timeout=0.1)
            
            if request_data:
                _, request_json = request_data
                request = json.loads(request_json)
                
                # Process the request
                response = await self.handle_request(request)
                
                # Send response back
                if response:
                    request_id = request.get('id')
                    await self.redis.set(
                        f'{self.redis_prefix}:response_{request_id}', 
                        json.dumps(response),
                        ex=60  # Expire after 60 seconds
                    )
                    
        except asyncio.TimeoutError:
            # Normal timeout, continue
            pass
        except Exception as e:
            logger.error(f"Error processing web request: {e}")
    
    @request_processor.before_loop
    async def before_request_processor(self):
        """Wait for bot to be ready before starting"""
        await self.bot.wait_until_ready()
    
    async def handle_request(self, request: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Handle different types of requests from web server"""
        request_type = request.get('type')
        data = request.get('data', {})
        
        try:
            if request_type == 'get_users':
                return await self.get_users(data.get('user_ids', []))
            elif request_type == 'get_channels':
                return await self.get_channels(data.get('channel_ids', []))
            elif request_type == 'get_guild_info':
                return await self.get_guild_info()
            elif request_type == 'get_user_roles':
                return await self.get_user_roles(data.get('user_id'))
            else:
                logger.warning(f"Unknown request type: {request_type}")
                return {'error': f'Unknown request type: {request_type}'}
                
        except Exception as e:
            logger.error(f"Error handling request {request_type}: {e}")
            return {'error': str(e)}
    
    async def get_users(self, user_ids: list) -> Dict[str, Any]:
        """Get Discord user information"""
        users = {}
        
        for user_id in user_ids:
            try:
                user = self.bot.get_user(int(user_id))
                if not user:
                    # Try fetching if not in cache
                    user = await self.bot.fetch_user(int(user_id))
                
                if user:
                    users[str(user_id)] = {
                        'id': user.id,
                        'username': user.name,
                        'display_name': user.display_name,
                        'discriminator': user.discriminator,
                        'avatar_url': str(user.avatar.url) if user.avatar else None,
                        'bot': user.bot
                    }
                else:
                    users[str(user_id)] = {
                        'id': user_id,
                        'username': f'Unknown User',
                        'display_name': f'Unknown User',
                        'discriminator': '0000',
                        'avatar_url': None,
                        'bot': False
                    }
                    
            except Exception as e:
                logger.error(f"Error fetching user {user_id}: {e}")
                users[str(user_id)] = {
                    'id': user_id,
                    'username': f'Error_{user_id}',
                    'display_name': f'Error_{user_id}',
                    'discriminator': '0000',
                    'avatar_url': None,
                    'bot': False
                }
        
        return {'users': users}
    
    async def get_channels(self, channel_ids: list) -> Dict[str, Any]:
        """Get Discord channel information"""
        channels = {}
        
        for channel_id in channel_ids:
            try:
                channel = self.bot.get_channel(int(channel_id))
                if channel:
                    channels[str(channel_id)] = {
                        'id': channel.id,
                        'name': channel.name,
                        'type': str(channel.type),
                        'guild_id': channel.guild.id if hasattr(channel, 'guild') else None,
                        'guild_name': channel.guild.name if hasattr(channel, 'guild') else None
                    }
                    
            except Exception as e:
                logger.error(f"Error fetching channel {channel_id}: {e}")
        
        return {'channels': channels}
    
    async def get_guild_info(self) -> Dict[str, Any]:
        """Get guild information"""
        try:
            import os
            guild_id = int(os.getenv('DISCORD_GUILD_ID'))
            guild = self.bot.get_guild(guild_id)
            
            if guild:
                return {
                    'guild': {
                        'id': guild.id,
                        'name': guild.name,
                        'member_count': guild.member_count,
                        'icon_url': str(guild.icon.url) if guild.icon else None,
                        'created_at': guild.created_at.isoformat()
                    }
                }
            else:
                return {'error': 'Guild not found'}
                
        except Exception as e:
            logger.error(f"Error getting guild info: {e}")
            return {'error': str(e)}
    
    async def get_user_roles(self, user_id: int) -> Dict[str, Any]:
        """Get user roles in the main guild"""
        try:
            import os
            guild_id = int(os.getenv('DISCORD_GUILD_ID'))
            guild = self.bot.get_guild(guild_id)
            
            if guild:
                member = guild.get_member(user_id)
                if member:
                    roles = []
                    for role in member.roles:
                        if role.name != '@everyone':  # Skip @everyone role
                            roles.append({
                                'id': role.id,
                                'name': role.name,
                                'color': role.color.value,
                                'permissions': role.permissions.value
                            })
                    
                    return {'roles': roles}
                else:
                    return {'error': 'Member not found'}
            else:
                return {'error': 'Guild not found'}
                
        except Exception as e:
            logger.error(f"Error getting user roles: {e}")
            return {'error': str(e)}


async def setup(bot: discord_commands.Bot):
    """Add the IPC handler to the bot"""
    await bot.add_cog(WebIPCHandler(bot))