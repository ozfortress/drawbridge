# Drawbridge Web Interface

This directory contains the web server components for viewing match and team communications from the Drawbridge Discord bot.

## Features

- **Match Communications**: View logs from Discord match channels
- **Team Communications**: View team-specific chat logs  
- **Search & Filter**: Autocomplete search for matches and teams
- **Role Resolution**: Discord role mentions resolved to team names
- **User Identification**: Color-coded users (captains, admins, casters, etc.)
- **Direct Links**: Jump to specific match/team logs via URLs

## Web Servers

### `simple_web_server.py`
- **Purpose**: Standalone web server without Discord integration
- **Use case**: View logs when Discord bot is not running
- **Database**: Direct database access for log retrieval
- **Performance**: Lightweight, minimal dependencies

### `web_server.py` 
- **Purpose**: Full-featured web server with Discord integration
- **Use case**: Real-time log viewing with user resolution
- **Discord Integration**: Resolves Discord user IDs to names/avatars
- **IPC**: Communicates with Discord bot via WebIPCHandler

## Quick Start

### Option 1: Integrated with Discord Bot
Add to your environment file:
```env
START_WEB_SERVER=true
WEB_HOST=0.0.0.0
WEB_PORT=8080
```

Then run the main bot:
```bash
python app.py
```

### Option 2: Standalone Web Server
```bash
cd web/
python run_web_server.py
```

### Option 3: Full-Featured Web Server
```bash
cd web/
python web_server.py
```

## URLs

- **Main Interface**: `http://localhost:8080/`
- **Match Logs**: `http://localhost:8080/match/123`
- **Team Logs**: `http://localhost:8080/team/456`
- **Roster Logs**: `http://localhost:8080/roster/789`

## Environment Variables

```env
# Web Server Configuration
WEB_HOST=0.0.0.0          # Listen address (0.0.0.0 for all interfaces)
WEB_PORT=8080             # Web server port
START_WEB_SERVER=true     # Start web server with bot

# Database Configuration (required)
DB_HOST=localhost
DB_USER=drawbridge
DB_PASS=your_password
DB_DATABASE=drawbridge

# Discord Role IDs (for user identification)
ROLE_ADMIN_6S=123...
ROLE_CASTER_APPROVED=456...
ROLE_DEVELOPER=789...
# ... etc
```

## API Endpoints

- `GET /api/logs` - Get match/team communication logs
- `GET /api/matches` - Get list of matches for filtering
- `GET /api/teams` - Get list of teams for filtering  
- `GET /api/stats` - Get database statistics
- `GET /api/match/<id>` - Get specific match details

## User Role Colors

- **🔴 Red**: Away team captain
- **🔵 Blue**: Home team captain  
- **🌊 Cyan**: OzFortress admins
- **🟡 Yellow**: Approved casters
- **🟢 Green**: Developers
- **⚪ Grey**: Bots
- **🟣 Purple**: Other roles

## Database Schema

The web interface reads from these database tables:
- `logs` - Match and team communications
- `matches` - Match information (home/away teams, division)
- `teams` - Team information (names, divisions, role IDs)
- `users` - Synced Discord users

## Development

### Adding New Features
1. Modify the appropriate web server file
2. Update templates in `templates/` directory
3. Test with both standalone and integrated modes
4. Update this README with new functionality

### Template Structure
```
templates/
└── logs.html    # Main log viewer interface
```

## Troubleshooting

### Common Issues

1. **"Module not found" errors**: Make sure you're running from the correct directory
2. **Database connection failed**: Check your database configuration in environment variables  
3. **Templates not found**: Verify the `templates/` directory is in the `web/` folder
4. **Port already in use**: Change `WEB_PORT` to an available port

### Debug Mode
Set `LOG_LEVEL=DEBUG` in your environment to see detailed logging.

## Production Deployment

For production use, the integrated mode is recommended:
1. Set `START_WEB_SERVER=true` in your production environment
2. Configure proper `WEB_HOST` and `WEB_PORT` 
3. Use the existing Docker deployment pipeline
4. Web interface will be available alongside the Discord bot