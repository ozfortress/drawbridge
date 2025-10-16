#!/usr/bin/env python3
"""
Separate web server for log viewing that communicates with the Discord bot
"""

import asyncio
import json
import logging
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any
import aiofiles
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Add parent directory to path for module imports
parent_dir = Path(__file__).parent.parent
sys.path.insert(0, str(parent_dir))
try:
    import redis.asyncio as aioredis
    REDIS_AVAILABLE = True
except ImportError:
    print("⚠️ redis not available - Discord user resolution disabled")
    REDIS_AVAILABLE = False
    aioredis = None

from quart import Quart, render_template, request, jsonify
from quart_cors import cors
import os
from pathlib import Path

# Import your modules
from modules.logging_config import get_logger
from modules import database

# Set template folder to the correct location
template_folder = Path(__file__).parent / 'templates'
app = Quart(__name__, template_folder=str(template_folder))
app = cors(app)

logger = get_logger('drawbridge.web', 'web.log')

class LogWebServer:
    def __init__(self):
        self.db = None
        self.redis = None
        
    async def init_db(self):
        """Initialize database connection"""
        try:
            self.db = database.Database(conn_params={
                "database": os.getenv('DB_DATABASE'),
                "user": os.getenv('DB_USER'),
                "password": os.getenv('DB_PASS'),
                "host": os.getenv('DB_HOST'),
                "port": int(os.getenv('DB_PORT', 5432))
            })
            logger.info("Database connection established")
        except Exception as e:
            logger.warning(f"Database connection failed: {e}")
            self.db = None
        
    async def init_redis(self):
        """Initialize Redis for IPC with Discord bot"""
        if not REDIS_AVAILABLE:
            logger.info("Redis/aioredis not available - IPC disabled")
            self.redis = None
            return
            
        try:
            self.redis = await aioredis.from_url(
                os.getenv('REDIS_URL', 'redis://localhost:6379'),
                decode_responses=True
            )
            # Set environment-specific prefix for Redis keys
            self.redis_prefix = os.getenv('REDIS_PREFIX', 'drawbridge')
            logger.info("Redis IPC connection established")
        except Exception as e:
            logger.warning(f"Redis not available for IPC: {e}")
            self.redis = None
    
    async def request_discord_data(self, request_type: str, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Request data from Discord bot via Redis"""
        if not self.redis:
            return None
            
        try:
            # Create request
            request_id = f"web_request_{datetime.now().timestamp()}"
            request_data = {
                'id': request_id,
                'type': request_type,
                'data': data,
                'timestamp': datetime.now().isoformat()
            }
            
            # Send request to Discord bot
            await self.redis.lpush(f'{self.redis_prefix}:discord_requests', json.dumps(request_data))
            
            # Wait for response (with timeout)
            for _ in range(50):  # 5 second timeout
                response = await self.redis.get(f'{self.redis_prefix}:response_{request_id}')
                if response:
                    await self.redis.delete(f'{self.redis_prefix}:response_{request_id}')
                    return json.loads(response)
                await asyncio.sleep(0.1)
                
            logger.warning(f"Timeout waiting for Discord response: {request_type}")
            return None
            
        except Exception as e:
            logger.error(f"Error requesting Discord data: {e}")
            return None

web_server = LogWebServer()

@app.before_serving
async def startup():
    """Initialize connections on startup"""
    await web_server.init_db()
    await web_server.init_redis()

@app.route('/')
async def index():
    """Main log viewer page"""
    return await render_template('logs.html')

@app.route('/api/logs')
async def get_logs():
    """API endpoint to get logs with Discord user resolution"""
    try:
        # Get query parameters
        log_type = request.args.get('type', 'all')
        limit = int(request.args.get('limit', 100))
        offset = int(request.args.get('offset', 0))
        
        # Read log files
        logs = []
        log_dir = Path('logs')
        
        if log_type == 'all' or log_type == 'sync':
            sync_logs = await read_log_file(log_dir / 'sync.log', limit, offset)
            logs.extend(sync_logs)
            
        if log_type == 'all' or log_type == 'discord':
            discord_logs = await read_log_file(log_dir / 'discord_events.log', limit, offset)
            logs.extend(discord_logs)
            
        # Sort by timestamp
        logs.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
        
        # Resolve Discord user IDs to usernames
        logs_with_users = await resolve_discord_users(logs)
        
        return jsonify({
            'logs': logs_with_users[:limit],
            'total': len(logs_with_users)
        })
        
    except Exception as e:
        logger.error(f"Error getting logs: {e}")
        return jsonify({'error': str(e)}), 500

async def read_log_file(file_path: Path, limit: int, offset: int) -> list:
    """Read and parse log file"""
    logs = []
    
    if not file_path.exists():
        return logs
        
    try:
        async with aiofiles.open(file_path, 'r', encoding='utf-8') as f:
            lines = await f.readlines()
            
        for line in lines[offset:offset+limit]:
            line = line.strip()
            if not line:
                continue
                
            # Parse log line (adjust based on your log format)
            try:
                # Assuming format: [timestamp] level module: message
                parts = line.split('] ', 2)
                if len(parts) >= 3:
                    timestamp = parts[0][1:]  # Remove leading [
                    level_module = parts[1]
                    message = parts[2]
                    
                    level_parts = level_module.split(' ', 1)
                    level = level_parts[0] if level_parts else 'INFO'
                    module = level_parts[1] if len(level_parts) > 1 else 'unknown'
                    
                    logs.append({
                        'timestamp': timestamp,
                        'level': level,
                        'module': module,
                        'message': message,
                        'raw': line
                    })
            except Exception as e:
                # If parsing fails, include raw line
                logs.append({
                    'timestamp': '',
                    'level': 'UNKNOWN',
                    'module': 'parser',
                    'message': line,
                    'raw': line
                })
                
    except Exception as e:
        logger.error(f"Error reading log file {file_path}: {e}")
        
    return logs

async def resolve_discord_users(logs: list) -> list:
    """Resolve Discord user IDs to usernames in log messages"""
    import re
    
    # Find all Discord user IDs in messages
    user_ids = set()
    user_id_pattern = r'<@(\d+)>|ID: (\d+)|Discord ID: (\d+)'
    
    for log in logs:
        matches = re.findall(user_id_pattern, log['message'])
        for match in matches:
            for group in match:
                if group and group.isdigit():
                    user_ids.add(int(group))
    
    # Request user data from Discord bot
    if user_ids and web_server.redis:
        user_data = await web_server.request_discord_data('get_users', {
            'user_ids': list(user_ids)
        })
        
        if user_data and 'users' in user_data:
            # Replace user IDs with usernames in messages
            for log in logs:
                message = log['message']
                for user_id, user_info in user_data['users'].items():
                    username = user_info.get('username', f'User_{user_id}')
                    # Replace various formats
                    message = message.replace(f'<@{user_id}>', f'@{username}')
                    message = message.replace(f'ID: {user_id}', f'ID: {user_id} ({username})')
                    message = message.replace(f'Discord ID: {user_id}', f'Discord ID: {user_id} ({username})')
                
                log['message_formatted'] = message
                log['users_resolved'] = True
    
    return logs

@app.route('/api/stats')
async def get_stats():
    """Get log statistics"""
    try:
        stats = {
            'total_synced_users': 0,
            'recent_syncs': 0,
            'error_count': 0
        }
        
        if web_server.db:
            # Get database stats
            stats['total_synced_users'] = len(web_server.db.synced_users.get_all())
            
        return jsonify(stats)
        
    except Exception as e:
        logger.error(f"Error getting stats: {e}")
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    import uvicorn
    
    port = int(os.getenv('WEB_PORT', 8080))
    host = os.getenv('WEB_HOST', '127.0.0.1')
    
    logger.info(f"Starting log web server on {host}:{port}")
    
    # Run with uvicorn for better async performance
    uvicorn.run(
        "web_server:app",
        host=host,
        port=port,
        log_level="info",
        access_log=True
    )