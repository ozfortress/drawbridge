"""
Health monitoring system for Drawbridge bot.
Monitors bot health and sends alerts via Discord webhook when issues are detected.
"""

import asyncio
import aiohttp
import logging
import os
import sys
import time
import traceback
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, Dict, Any
from discord.ext import tasks
import discord

from modules.logging_config import get_logger


class HealthMonitor:
    """Monitor bot health and send alerts when issues are detected."""
    
    def __init__(self, bot: discord.Client, db=None):
        self.bot = bot
        self.db = db
        self.logger = get_logger('drawbridge.health_monitor', 'health_monitor.log')
        
        # Health check configuration
        self.webhook_url = os.getenv('HEALTH_WEBHOOK_URL')
        self.check_interval = int(os.getenv('HEALTH_CHECK_INTERVAL', '60'))  # seconds
        self.alert_cooldown = int(os.getenv('HEALTH_ALERT_COOLDOWN', '1800'))  # 30 minutes
        self.max_log_lines = int(os.getenv('HEALTH_LOG_LINES', '100'))
        
        # Health status tracking
        self.last_heartbeat = time.time()
        self.last_alert_time = 0
        self.consecutive_failures = 0
        self.max_failures_before_alert = int(os.getenv('HEALTH_MAX_FAILURES', '3'))
        
        # Health metrics
        self.health_metrics = {
            'bot_ready': False,
            'database_connected': False,
            'last_command_time': None,
            'websocket_connected': False,
            'memory_usage_mb': 0,
            'uptime_seconds': 0
        }
        
        self.start_time = time.time()
        
        if not self.webhook_url:
            self.logger.warning('HEALTH_WEBHOOK_URL not configured - health alerts will be disabled')
    
    def update_heartbeat(self):
        """Update the last heartbeat timestamp."""
        self.last_heartbeat = time.time()
        self.consecutive_failures = 0
    
    def update_metric(self, metric_name: str, value: Any):
        """Update a specific health metric."""
        self.health_metrics[metric_name] = value
        self.logger.debug(f'Updated health metric {metric_name}: {value}')
    
    async def perform_health_check(self) -> Dict[str, Any]:
        """Perform comprehensive health check of the bot."""
        current_time = time.time()
        health_status = {
            'timestamp': datetime.now().isoformat(),
            'healthy': True,
            'issues': [],
            'metrics': self.health_metrics.copy()
        }
        
        # Update uptime
        self.health_metrics['uptime_seconds'] = int(current_time - self.start_time)
        
        # Check if bot is ready
        if not self.bot.is_ready():
            health_status['healthy'] = False
            health_status['issues'].append('Bot is not ready')
            self.health_metrics['bot_ready'] = False
        else:
            self.health_metrics['bot_ready'] = True
        
        # Check websocket connection
        if self.bot.ws is None or self.bot.ws.socket.closed:
            health_status['healthy'] = False
            health_status['issues'].append('WebSocket connection is closed')
            self.health_metrics['websocket_connected'] = False
        else:
            self.health_metrics['websocket_connected'] = True
        
        # Check database connection if available
        if self.db:
            try:
                # Simple database connectivity test using the health_check method
                is_healthy = self.db.health_check()
                self.health_metrics['database_connected'] = is_healthy
                if not is_healthy:
                    health_status['healthy'] = False
                    health_status['issues'].append('Database health check failed')
            except Exception as e:
                health_status['healthy'] = False
                health_status['issues'].append(f'Database connection failed: {str(e)}')
                self.health_metrics['database_connected'] = False
        
        # Check memory usage
        try:
            import psutil
            process = psutil.Process()
            memory_mb = process.memory_info().rss / 1024 / 1024
            self.health_metrics['memory_usage_mb'] = round(memory_mb, 2)
            
            # Alert if memory usage is very high (over 1GB)
            if memory_mb > 1024:
                health_status['issues'].append(f'High memory usage: {memory_mb:.2f} MB')
        except ImportError:
            # psutil not available, skip memory check
            pass
        except Exception as e:
            self.logger.warning(f'Failed to get memory usage: {e}')
        
        # Check if heartbeat is recent
        time_since_heartbeat = current_time - self.last_heartbeat
        if time_since_heartbeat > (self.check_interval * 2):
            health_status['healthy'] = False
            health_status['issues'].append(f'No heartbeat for {time_since_heartbeat:.1f} seconds')
        
        # Update health status
        health_status['metrics'] = self.health_metrics
        
        return health_status
    
    async def get_recent_logs(self) -> str:
        """Get the last N lines from the main log file."""
        try:
            log_file = Path('logs/drawbridge.log')
            if not log_file.exists():
                return "Log file not found"
            
            with open(log_file, 'r', encoding='utf-8') as f:
                lines = f.readlines()
            
            # Get last N lines
            recent_lines = lines[-self.max_log_lines:]
            return ''.join(recent_lines)
        
        except Exception as e:
            self.logger.error(f'Failed to read log file: {e}')
            return f"Failed to read logs: {str(e)}"
    
    async def send_health_alert(self, health_status: Dict[str, Any]):
        """Send health alert to Discord webhook."""
        if not self.webhook_url:
            self.logger.warning('Cannot send health alert - webhook URL not configured')
            return
        
        current_time = time.time()
        
        # Check cooldown
        if current_time - self.last_alert_time < self.alert_cooldown:
            self.logger.debug(f'Health alert on cooldown for {self.alert_cooldown - (current_time - self.last_alert_time):.0f} more seconds')
            return
        
        try:
            # Get recent logs
            recent_logs = await self.get_recent_logs()
            
            # Create embed for the alert
            embed = {
                "title": "🚨 Bot Health Alert",
                "description": f"Bot health check failed at {health_status['timestamp']}",
                "color": 0xFF0000,  # Red
                "fields": [
                    {
                        "name": "Issues Detected",
                        "value": '\n'.join(f"• {issue}" for issue in health_status['issues'][:10]),  # Limit to 10 issues
                        "inline": False
                    },
                    {
                        "name": "Bot Status",
                        "value": f"Ready: {health_status['metrics']['bot_ready']}\nWebSocket: {health_status['metrics']['websocket_connected']}\nDatabase: {health_status['metrics']['database_connected']}",
                        "inline": True
                    },
                    {
                        "name": "System Metrics",
                        "value": f"Uptime: {health_status['metrics']['uptime_seconds']}s\nMemory: {health_status['metrics']['memory_usage_mb']} MB\nFailures: {self.consecutive_failures}",
                        "inline": True
                    }
                ],
                "timestamp": datetime.utcnow().isoformat(),
                "footer": {
                    "text": f"Environment: {os.getenv('ENVIRONMENT', 'unknown')}"
                }
            }
            
            # Prepare webhook payload
            webhook_data = {
                "content": f"<@&{os.getenv('ROLE_DEVELOPER', '')}> Bot health check failed!",
                "embeds": [embed]
            }
            
            # Create log file attachment if logs are available
            files = {}
            if recent_logs and recent_logs != "Log file not found":
                log_filename = f"health_alert_logs_{int(current_time)}.txt"
                files['file'] = (log_filename, recent_logs.encode('utf-8'), 'text/plain')
            
            # Send webhook
            async with aiohttp.ClientSession() as session:
                if files:
                    # Send with file attachment
                    form_data = aiohttp.FormData()
                    form_data.add_field('payload_json', 
                                      str(webhook_data).replace("'", '"'), 
                                      content_type='application/json')
                    form_data.add_field('file', files['file'][1], 
                                      filename=files['file'][0], 
                                      content_type=files['file'][2])
                    
                    async with session.post(self.webhook_url, data=form_data) as response:
                        if response.status == 204:
                            self.logger.info('Health alert sent successfully with log attachment')
                        else:
                            self.logger.error(f'Failed to send health alert with attachment: {response.status}')
                else:
                    # Send without attachment
                    async with session.post(self.webhook_url, json=webhook_data) as response:
                        if response.status == 204:
                            self.logger.info('Health alert sent successfully')
                        else:
                            self.logger.error(f'Failed to send health alert: {response.status}')
            
            self.last_alert_time = current_time
            
        except Exception as e:
            self.logger.error(f'Failed to send health alert: {e}', exc_info=True)
    
    async def send_recovery_notification(self):
        """Send notification when bot recovers from health issues."""
        if not self.webhook_url:
            return
        
        try:
            embed = {
                "title": "✅ Bot Health Recovered",
                "description": f"Bot health checks are now passing",
                "color": 0x00FF00,  # Green
                "fields": [
                    {
                        "name": "Recovery Time",
                        "value": f"<t:{int(time.time())}:F>",
                        "inline": True
                    },
                    {
                        "name": "Uptime",
                        "value": f"{self.health_metrics['uptime_seconds']}s",
                        "inline": True
                    }
                ],
                "timestamp": datetime.utcnow().isoformat()
            }
            
            webhook_data = {
                "embeds": [embed]
            }
            
            async with aiohttp.ClientSession() as session:
                async with session.post(self.webhook_url, json=webhook_data) as response:
                    if response.status == 204:
                        self.logger.info('Health recovery notification sent')
                    else:
                        self.logger.error(f'Failed to send recovery notification: {response.status}')
        
        except Exception as e:
            self.logger.error(f'Failed to send recovery notification: {e}')
    
    @tasks.loop(seconds=60)  # Default interval, will be updated in start_monitoring
    async def health_check_task(self):
        """Periodic health check task."""
        try:
            health_status = await self.perform_health_check()
            
            if health_status['healthy']:
                # Health check passed
                if self.consecutive_failures >= self.max_failures_before_alert:
                    # Bot recovered from previous failures
                    await self.send_recovery_notification()
                
                self.consecutive_failures = 0
                self.update_heartbeat()
                self.logger.debug('Health check passed')
            
            else:
                # Health check failed
                self.consecutive_failures += 1
                self.logger.warning(f'Health check failed (attempt {self.consecutive_failures}): {health_status["issues"]}')
                
                # Send alert if we've exceeded the failure threshold
                if self.consecutive_failures >= self.max_failures_before_alert:
                    await self.send_health_alert(health_status)
        
        except Exception as e:
            self.logger.error(f'Error in health check task: {e}', exc_info=True)
            self.consecutive_failures += 1
    
    @health_check_task.before_loop
    async def before_health_check(self):
        """Wait for bot to be ready before starting health checks."""
        await self.bot.wait_until_ready()
        self.logger.info('Starting health monitoring...')
    
    def start_monitoring(self):
        """Start the health monitoring system."""
        if self.webhook_url:
            # Update the task interval
            self.health_check_task.change_interval(seconds=self.check_interval)
            self.health_check_task.start()
            self.logger.info(f'Health monitoring started with {self.check_interval}s interval')
        else:
            self.logger.warning('Health monitoring disabled - no webhook URL configured')
    
    def stop_monitoring(self):
        """Stop the health monitoring system."""
        if self.health_check_task.is_running():
            self.health_check_task.stop()
            self.logger.info('Health monitoring stopped')
    
    def get_health_status(self) -> Dict[str, Any]:
        """Get current health status (synchronous version for web endpoints)."""
        current_time = time.time()
        return {
            'timestamp': datetime.now().isoformat(),
            'healthy': self.consecutive_failures < self.max_failures_before_alert,
            'consecutive_failures': self.consecutive_failures,
            'uptime_seconds': int(current_time - self.start_time),
            'last_heartbeat': self.last_heartbeat,
            'metrics': self.health_metrics.copy()
        }


# Global health monitor instance
_health_monitor: Optional[HealthMonitor] = None


def get_health_monitor() -> Optional[HealthMonitor]:
    """Get the global health monitor instance."""
    return _health_monitor


def initialize_health_monitor(bot: discord.Client, db=None) -> HealthMonitor:
    """Initialize the global health monitor."""
    global _health_monitor
    _health_monitor = HealthMonitor(bot, db)
    return _health_monitor