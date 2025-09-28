"""
Centralized logging configuration for Drawbridge.
"""

import logging
import logging.handlers
import os
import sys
from typing import Optional
from datetime import datetime
import functools


# ANSI Color codes for console output
class Colors:
    RESET = '\033[0m'
    BOLD = '\033[1m'
    
    # Foreground colors
    BLACK = '\033[30m'
    RED = '\033[31m'
    GREEN = '\033[32m'
    YELLOW = '\033[33m'
    BLUE = '\033[34m'
    MAGENTA = '\033[35m'
    CYAN = '\033[36m'
    WHITE = '\033[37m'
    
    # Bright foreground colors
    BRIGHT_BLACK = '\033[90m'
    BRIGHT_RED = '\033[91m'
    BRIGHT_GREEN = '\033[92m'
    BRIGHT_YELLOW = '\033[93m'
    BRIGHT_BLUE = '\033[94m'
    BRIGHT_MAGENTA = '\033[95m'
    BRIGHT_CYAN = '\033[96m'
    BRIGHT_WHITE = '\033[97m'


class ColoredFormatter(logging.Formatter):
    """Custom formatter that adds Discord-style colors to console output."""
    
    # Define colors for each log level
    LEVEL_COLORS = {
        'DEBUG': Colors.BRIGHT_BLACK,
        'INFO': Colors.BRIGHT_BLUE,
        'WARNING': Colors.BRIGHT_YELLOW,
        'ERROR': Colors.BRIGHT_RED,
        'CRITICAL': Colors.RED + Colors.BOLD,
    }
    
    def format(self, record):
        # Get the base formatted message
        formatted = super().format(record)
        
        # Add color to the log level
        level_color = self.LEVEL_COLORS.get(record.levelname, Colors.WHITE)
        
        # Split the formatted message to colorize parts
        parts = formatted.split(' ', 3)  # [timestamp], [level], [logger], message
        if len(parts) >= 4:
            timestamp = parts[0] + ' ' + parts[1]  # [2025-09-28 14:03:21]
            level = parts[2]  # INFO
            logger = parts[3].split(':', 1)[0]  # drawbridge.main
            message = parts[3].split(':', 1)[1] if ':' in parts[3] else ''
            
            # Apply colors
            colored_timestamp = f"{Colors.BRIGHT_BLACK}{timestamp}{Colors.RESET}"
            colored_level = f"{level_color}{level:<8s}{Colors.RESET}"
            colored_logger = f"{Colors.BRIGHT_CYAN}{logger:<20s}{Colors.RESET}"
            
            return f"{colored_timestamp} {colored_level} {colored_logger}: {message}"
        
        return formatted


class DrawbridgeLogger:
    """Centralized logging configuration for all Drawbridge modules."""
    
    _instance = None
    _loggers = {}
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(DrawbridgeLogger, cls).__new__(cls)
            cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if self._initialized:
            return
        
        self._initialized = True
        self.log_level = os.getenv('LOG_LEVEL', 'INFO').upper()
        self.logs_dir = 'logs'
        
        # Ensure logs directory exists
        if not os.path.exists(self.logs_dir):
            os.makedirs(self.logs_dir)
        
        # Configure root logger
        self._configure_root_logger()
    
    def _configure_root_logger(self):
        """Configure the root logger with basic settings."""
        root_logger = logging.getLogger()
        root_logger.setLevel(logging.DEBUG)
        
        # Clear any existing handlers
        root_logger.handlers.clear()
        
        # Create formatters
        console_formatter = ColoredFormatter(
            '[%(asctime)s] %(levelname)-8s %(name)-20s: %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        
        file_formatter = logging.Formatter(
            '[%(asctime)s] %(levelname)-8s %(name)-20s: %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        
        # Console handler with colors
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setLevel(getattr(logging, self.log_level))
        console_handler.setFormatter(console_formatter)
        root_logger.addHandler(console_handler)
        
        # Main file handler with rotation (no colors for files)
        main_file_handler = logging.handlers.RotatingFileHandler(
            filename=os.path.join(self.logs_dir, 'drawbridge.log'),
            maxBytes=50*1024*1024,  # 50MB
            backupCount=5,
            encoding='utf-8'
        )
        main_file_handler.setLevel(logging.DEBUG)
        main_file_handler.setFormatter(file_formatter)
        root_logger.addHandler(main_file_handler)
    
    def get_logger(self, name: str, log_file: Optional[str] = None) -> logging.Logger:
        """
        Get a logger instance for a specific module.
        
        Args:
            name: Logger name (usually module name)
            log_file: Optional separate log file for this logger
            
        Returns:
            Configured logger instance
        """
        if name in self._loggers:
            return self._loggers[name]
        
        logger = logging.getLogger(name)
        logger.setLevel(logging.DEBUG)
        
        # Add specific file handler if requested
        if log_file:
            file_handler = logging.handlers.RotatingFileHandler(
                filename=os.path.join(self.logs_dir, log_file),
                maxBytes=10*1024*1024,  # 10MB
                backupCount=3,
                encoding='utf-8'
            )
            file_handler.setLevel(logging.DEBUG)
            
            file_formatter = logging.Formatter(
                '[%(asctime)s] %(levelname)-8s %(name)-20s: %(message)s',
                datefmt='%Y-%m-%d %H:%M:%S'
            )
            file_handler.setFormatter(file_formatter)
            logger.addHandler(file_handler)
        
        self._loggers[name] = logger
        return logger


def get_logger(name: str, log_file: Optional[str] = None) -> logging.Logger:
    """Convenience function to get a logger."""
    return DrawbridgeLogger().get_logger(name, log_file)


def log_command_execution(logger: logging.Logger):
    """
    Decorator to log command execution details.
    
    Args:
        logger: Logger instance to use for logging
        
    Returns:
        Decorator function
    """
    def decorator(func):
        @functools.wraps(func)
        async def wrapper(self, interaction, *args, **kwargs):
            cmd_name = func.__name__
            user_info = f"{interaction.user} (ID: {interaction.user.id})"
            
            # Log command start
            logger.info(f"Command '{cmd_name}' started by {user_info}")
            
            # Log arguments (be careful with sensitive data)
            if args:
                # Filter out sensitive arguments
                safe_args = []
                for arg in args:
                    if isinstance(arg, str) and len(arg) > 50:
                        safe_args.append(f"{arg[:50]}...")
                    else:
                        safe_args.append(arg)
                logger.debug(f"Command '{cmd_name}' args: {safe_args}")
            
            if kwargs:
                logger.debug(f"Command '{cmd_name}' kwargs: {kwargs}")
            
            start_time = datetime.now()
            
            try:
                result = await func(self, interaction, *args, **kwargs)
                
                # Log successful completion
                duration = (datetime.now() - start_time).total_seconds()
                logger.info(f"Command '{cmd_name}' completed successfully in {duration:.2f}s")
                
                return result
                
            except Exception as e:
                # Log error
                duration = (datetime.now() - start_time).total_seconds()
                logger.error(f"Command '{cmd_name}' failed after {duration:.2f}s: {e}", exc_info=True)
                raise
                
        return wrapper
    return decorator


def log_function_call(logger: logging.Logger, log_args: bool = False):
    """
    Decorator to log function calls.
    
    Args:
        logger: Logger instance to use
        log_args: Whether to log function arguments
        
    Returns:
        Decorator function
    """
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            func_name = func.__name__
            
            if log_args:
                logger.debug(f"Calling {func_name} with args: {args}, kwargs: {kwargs}")
            else:
                logger.debug(f"Calling {func_name}")
            
            try:
                result = func(*args, **kwargs)
                logger.debug(f"{func_name} completed successfully")
                return result
            except Exception as e:
                logger.error(f"{func_name} failed: {e}", exc_info=True)
                raise
                
        return wrapper
    return decorator


def log_async_function_call(logger: logging.Logger, log_args: bool = False):
    """
    Decorator to log async function calls.
    
    Args:
        logger: Logger instance to use
        log_args: Whether to log function arguments
        
    Returns:
        Decorator function
    """
    def decorator(func):
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            func_name = func.__name__
            
            if log_args:
                logger.debug(f"Calling async {func_name} with args: {args}, kwargs: {kwargs}")
            else:
                logger.debug(f"Calling async {func_name}")
            
            try:
                result = await func(*args, **kwargs)
                logger.debug(f"Async {func_name} completed successfully")
                return result
            except Exception as e:
                logger.error(f"Async {func_name} failed: {e}", exc_info=True)
                raise
                
        return wrapper
    return decorator


class DatabaseLogger:
    """Special logger for database operations."""
    
    def __init__(self):
        self.logger = get_logger('drawbridge.database', 'database.log')
    
    def log_query(self, query: str, params: tuple = None):
        """Log database queries."""
        if params:
            self.logger.debug(f"SQL Query: {query} | Params: {params}")
        else:
            self.logger.debug(f"SQL Query: {query}")
    
    def log_connection(self, operation: str):
        """Log database connection operations."""
        self.logger.debug(f"Database connection: {operation}")
    
    def log_error(self, operation: str, error: Exception):
        """Log database errors."""
        self.logger.error(f"Database error in {operation}: {error}", exc_info=True)


class DiscordEventLogger:
    """Special logger for Discord events."""
    
    def __init__(self):
        self.logger = get_logger('drawbridge.discord_events', 'discord_events.log')
    
    def log_event(self, event_name: str, details: str = None):
        """Log Discord events."""
        if details:
            self.logger.info(f"Discord event '{event_name}': {details}")
        else:
            self.logger.info(f"Discord event '{event_name}'")
    
    def log_message_event(self, event_type: str, message, additional_info: str = None):
        """Log message-related events."""
        user_info = f"{message.author} ({message.author.id})"
        channel_info = f"#{message.channel.name}" if hasattr(message.channel, 'name') else f"DM"
        
        info = f"User: {user_info} | Channel: {channel_info}"
        if additional_info:
            info += f" | {additional_info}"
            
        self.logger.info(f"Message {event_type}: {info}")


# Initialize the singleton
_logger_instance = DrawbridgeLogger()
