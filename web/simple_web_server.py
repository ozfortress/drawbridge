#!/usr/bin/env python3
"""
Simple web server without Redis/Discord integration
Use this if you just want log viewing without user resolution
"""

import asyncio
import os
import sys
from pathlib import Path
from dotenv import load_dotenv

# Load environment variables
# Check for production environment file first, then fallback to .env
if os.path.exists('../prod.env'):
    load_dotenv('../prod.env')
elif os.path.exists('prod.env'):
    load_dotenv('prod.env')
elif os.path.exists('../.env'):
    load_dotenv('../.env')
else:
    load_dotenv()

# Add parent directory to path for module imports
parent_dir = Path(__file__).parent.parent
sys.path.insert(0, str(parent_dir))

try:
    from modules.logging_config import get_logger
    from modules import database
    from modules.citadel import Citadel
    from quart import Quart, render_template, request, jsonify
    import aiofiles
except ImportError as e:
    print(f"❌ Missing dependency: {e}")
    print("Install with: pip install quart quart-cors aiofiles")
    sys.exit(1)

# Set template folder to the correct location
template_folder = Path(__file__).parent / 'templates'
app = Quart(__name__, template_folder=str(template_folder))
logger = get_logger('drawbridge.web.simple', 'web.log')

# Manual CORS implementation (more reliable than quart-cors)
@app.after_request
async def after_request(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    return response

@app.before_request
async def handle_preflight():
    from quart import request
    if request.method == "OPTIONS":
        from quart import Response
        response = Response()
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
        return response

class SimpleLogViewer:
    def __init__(self, shared_db=None):
        self.db = shared_db  # Use shared database if provided
        self.citadel = None
        self._match_cache = {}
        
    async def init_db(self):
        """Initialize database connection"""
        if self.db is not None:
            logger.info("Using shared database connection")
            return
            
        try:
            # Log the connection parameters (without password)
            logger.info(f"Attempting database connection to {os.getenv('DB_HOST')}:{os.getenv('DB_PORT', 3306)} as {os.getenv('DB_USER')}")
            
            self.db = database.Database(conn_params={
                "database": os.getenv('DB_DATABASE'),
                "user": os.getenv('DB_USER'),
                "password": os.getenv('DB_PASS'),
                "host": os.getenv('DB_HOST'),
                "port": int(os.getenv('DB_PORT', 3306))
            })
            logger.info("Database connection established successfully")
        except Exception as e:
            logger.error(f"Database connection failed: {e}")
            logger.error(f"Connection details - Host: {os.getenv('DB_HOST')}, Port: {os.getenv('DB_PORT', 3306)}, User: {os.getenv('DB_USER')}, Database: {os.getenv('DB_DATABASE')}")
            self.db = None
            
        # Initialize Citadel API if API key is available
        try:
            api_key = os.getenv('CITADEL_API_KEY')
            if api_key:
                self.citadel = Citadel(api_key)
                logger.info("Citadel API initialized")
            else:
                logger.warning("CITADEL_API_KEY not found, match name resolution disabled")
        except Exception as e:
            logger.warning(f"Citadel API not available: {e}")
            self.citadel = None
            
    async def get_match_display_name(self, match_id):
        """Get display name for a match using Citadel API with caching"""
        if not self.citadel or not match_id:
            return f"Match {match_id}"
            
        # Check cache first
        if match_id in self._match_cache:
            return self._match_cache[match_id]
            
        try:
            match_info = self.citadel.getMatch(match_id)
            
            # Format: "Home vs Away (Round X Season Y)"
            home_name = match_info.home_team.name if match_info.home_team else "Unknown"
            away_name = match_info.away_team.name if match_info.away_team else "TBD"
            round_info = match_info.round_name if match_info.round_name else f"Round {match_info.round_number}"
            league_name = match_info.league.name if match_info.league else "League"
            
            display_name = f"{home_name} vs {away_name} ({round_info})"
            
            # Cache the result
            self._match_cache[match_id] = display_name
            return display_name
            
        except Exception as e:
            logger.warning(f"Error fetching match info for {match_id}: {e}")
            # Cache the fallback too to avoid repeated API calls
            fallback = f"Match {match_id}"
            self._match_cache[match_id] = fallback
            return fallback

log_viewer = SimpleLogViewer()

def set_shared_database(db):
    """Set a shared database connection for the web server"""
    global log_viewer
    log_viewer = SimpleLogViewer(shared_db=db)
    logger.info("Web server configured with shared database connection")

# Role ID mappings for user identification
ROLE_MAPPINGS = {
    'admin': [
        int(os.getenv('ROLE_DIRECTOR', 0)),
        int(os.getenv('ROLE_HEADS_AC', 0)),
        int(os.getenv('ROLE_HEADS_6S', 0)),
        int(os.getenv('ROLE_HEADS_HL', 0)),
        int(os.getenv('ROLE_ADMIN_6S', 0)),
        int(os.getenv('ROLE_ADMIN_HL', 0)),
        int(os.getenv('ROLE_ADMIN_TRIAL', 0)),
    ],
    'developer': [int(os.getenv('ROLE_DEVELOPER', 0))],
    'caster': [
        int(os.getenv('ROLE_CASTER_APPROVED', 0)),
        int(os.getenv('ROLE_CASTER_UNAPPROVED', 0))
    ],
    'bot': [int(os.getenv('ROLE_BOT', 0))],
    'staff': [int(os.getenv('ROLE_STAFF', 0))]
}

def identify_user_role(user_roles, home_team_role_id=None, away_team_role_id=None):
    """
    Identify user role based on Discord roles
    Returns: (role_type, color_class)
    """
    if not user_roles:
        return 'user', 'user-role'
    
    # Convert to list if it's a single role
    if not isinstance(user_roles, list):
        user_roles = [user_roles]
    
    # Check for team captain roles first
    if home_team_role_id and home_team_role_id in user_roles:
        return 'captain_home', 'captain-home'
    if away_team_role_id and away_team_role_id in user_roles:
        return 'captain_away', 'captain-away'
    
    # Check for special roles
    for role_id in user_roles:
        if role_id in ROLE_MAPPINGS['admin']:
            return 'admin', 'admin-role'
        elif role_id in ROLE_MAPPINGS['developer']:
            return 'developer', 'dev-role'
        elif role_id in ROLE_MAPPINGS['caster']:
            return 'caster', 'caster-role'
        elif role_id in ROLE_MAPPINGS['bot']:
            return 'bot', 'bot-role'
        elif role_id in ROLE_MAPPINGS['staff']:
            return 'staff', 'staff-role'
    
    return 'user', 'user-role'

@app.before_serving
async def startup():
    """Initialize connections on startup"""
    await log_viewer.init_db()
    logger.info("Simple web log viewer started")

@app.route('/')
async def index():
    """Main log viewer page"""
    return await render_template('logs.html')

@app.route('/match/<int:match_id>')
async def match_logs(match_id):
    """View logs for a specific match"""
    return await render_template('logs.html', preset_match_id=match_id)

@app.route('/team/<int:team_id>')
async def team_logs(team_id):
    """View logs for a specific team by team_id"""
    return await render_template('logs.html', preset_team_id=team_id)

@app.route('/roster/<int:roster_id>')
async def roster_logs(roster_id):
    """View logs for a specific team by roster_id (converts to team_id)"""
    try:
        if not log_viewer.db:
            return jsonify({'error': 'Database not available'}), 500
        
        # Look up team_id by roster_id
        team_info = log_viewer.db.teams._fetch_one(
            "SELECT team_id FROM teams WHERE roster_id = ?", 
            (roster_id,)
        )
        
        if team_info and team_info.get('team_id'):
            team_id = team_info['team_id']
            return await render_template('logs.html', preset_team_id=team_id)
        else:
            # If no team_id found, still try with roster_id as team_id
            return await render_template('logs.html', preset_team_id=roster_id)
            
    except Exception as e:
        logger.error(f"Error looking up roster {roster_id}: {e}")
        # Fallback to using roster_id as team_id
        return await render_template('logs.html', preset_team_id=roster_id)

@app.route('/api/logs')
async def get_logs():
    """API endpoint to get match/team communication logs from database"""
    try:
        log_type = request.args.get('type', 'all')
        limit = int(request.args.get('limit', 100))
        offset = int(request.args.get('offset', 0))
        match_id = request.args.get('match_id')
        team_id = request.args.get('team_id')
        
        if not log_viewer.db:
            return jsonify({'error': 'Database not available'}), 500
        
        # Build query based on filters
        query = "SELECT * FROM logs"
        params = []
        conditions = []
        
        if match_id:
            conditions.append("match_id = ?")
            params.append(int(match_id))
            
        if team_id:
            conditions.append("team_id = ?")
            params.append(int(team_id))
            
        if log_type and log_type != 'all':
            conditions.append("log_type = ?")
            params.append(log_type.upper())
        
        if conditions:
            query += " WHERE " + " AND ".join(conditions)
            
        query += " ORDER BY log_timestamp DESC"
        
        if limit:
            query += f" LIMIT {limit}"
        if offset:
            query += f" OFFSET {offset}"
        
        # Execute query
        logs_data = log_viewer.db.logs._fetch_all(query, tuple(params) if params else ())
        
        # Get match context for role identification
        match_context = {}
        if match_id:
            match_info = log_viewer.db.matches.get_by_id(int(match_id))
            if match_info:
                home_team = log_viewer.db.teams.get_by_team_id(match_info.get('team_home')) if match_info.get('team_home') else None
                away_team = log_viewer.db.teams.get_by_team_id(match_info.get('team_away')) if match_info.get('team_away') else None
                
                match_context = {
                    'home_team_role_id': home_team.get('role_id') if home_team else None,
                    'away_team_role_id': away_team.get('role_id') if away_team else None
                }

        # Format logs for web display
        logs = []
        for log in logs_data:
            # Get team information for better display
            team_info = None
            team_name = None
            if log.get('team_id'):
                team_info = log_viewer.db.teams.get_by_team_id(log.get('team_id'))
                team_name = team_info.get('team_name') if team_info else f"Team {log.get('team_id')}"
            
            # Process message content to resolve role pings
            message_content = log.get('message_content', '')
            processed_message = await process_message_content(message_content, log_viewer.db)
            
            # Determine user role for highlighting - we'll need to get user roles from Discord or database
            # For now, we'll use basic role identification
            user_role_type, user_role_class = identify_user_role(
                [],  # We don't have user roles in logs table - could be enhanced later
                match_context.get('home_team_role_id'),
                match_context.get('away_team_role_id')
            )
            
            formatted_log = {
                'id': log.get('id'),
                'match_id': log.get('match_id'),
                'team_id': log.get('team_id'),
                'team_name': team_name,
                'team_info': team_info,
                'user_id': log.get('user_id'),
                'user_name': log.get('user_name'),
                'user_nick': log.get('user_nick'),
                'user_avatar': log.get('user_avatar'),
                'user_role_type': user_role_type,
                'user_role_class': user_role_class,
                'message_id': log.get('message_id'),
                'message_content': message_content,
                'processed_message': processed_message,
                'message_additionals': log.get('message_additionals'),
                'log_type': log.get('log_type'),
                'timestamp': log.get('log_timestamp').isoformat() if log.get('log_timestamp') else '',
                'level': 'INFO',  # Default level for display
                'module': f"match_{log.get('match_id')}" if log.get('match_id') else 'team_comms'
            }
            logs.append(formatted_log)
        
        return jsonify({
            'logs': logs,
            'total': len(logs),
            'discord_resolution': False,
            'data_source': 'database'
        })
        
    except Exception as e:
        logger.error(f"Error getting logs: {e}", exc_info=True)
        return jsonify({'error': str(e)}), 500

async def process_message_content(message_content: str, db) -> str:
    """Process message content to resolve role pings and mentions"""
    if not message_content or not db:
        return message_content
    
    import re
    
    # Copy the message to modify
    processed = message_content
    
    # Pattern for role mentions: <@&ROLE_ID>
    role_pattern = r'<@&(\d+)>'
    role_matches = re.findall(role_pattern, processed)
    
    for role_id in role_matches:
        try:
            # Try to find team with this role_id
            team_query = "SELECT * FROM teams WHERE role_id = ?"
            team_data = db.teams._fetch_one(team_query, (int(role_id),))
            
            if team_data:
                team_name = team_data.get('team_name', f'Team {team_data.get("team_id")}')
                # Replace role ping with team name
                processed = processed.replace(f'<@&{role_id}>', f'@{team_name}')
            else:
                # If no team found, just show as role mention
                processed = processed.replace(f'<@&{role_id}>', f'@Role({role_id})')
                
        except Exception as e:
            logger.warning(f"Error resolving role {role_id}: {e}")
            # Keep original if resolution fails
            continue
    
    # Pattern for user mentions: <@USER_ID> (already handled by existing logic in template)
    # We'll let the frontend handle user mentions if needed
    
    return processed

@app.route('/api/matches')
async def get_matches():
    """Get list of matches for filtering"""
    try:
        if not log_viewer.db:
            return jsonify({'error': 'Database not available'}), 500
        
        matches = log_viewer.db.matches.get_all()
        
        # Format matches for dropdown
        match_list = []
        for match in matches:
            match_id = match.get('match_id')
            
            # Get display name using Citadel API
            display_name = await log_viewer.get_match_display_name(match_id)
            
            match_list.append({
                'match_id': match_id,
                'display_name': display_name,
                'division': match.get('division'),
                'team_home': match.get('team_home'),
                'team_away': match.get('team_away'),
                'archived': match.get('archived')
            })
        
        return jsonify({'matches': match_list})
        
    except Exception as e:
        logger.error(f"Error getting matches: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/teams')
async def get_teams():
    """Get list of teams for filtering"""
    try:
        if not log_viewer.db:
            return jsonify({'error': 'Database not available'}), 500
        
        teams = log_viewer.db.teams.get_all()
        
        # Format teams for dropdown
        team_list = []
        for team in teams:
            team_list.append({
                'team_id': team.get('team_id'),
                'roster_id': team.get('roster_id'),
                'team_name': team.get('team_name'),
                'division': team.get('division'),
                'league_id': team.get('league_id')
            })
        
        return jsonify({'teams': team_list})
        
    except Exception as e:
        logger.error(f"Error getting teams: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/match/<int:match_id>/details')
async def get_match_details(match_id):
    """Get detailed match information including team details"""
    try:
        if not log_viewer.db:
            return jsonify({'error': 'Database not available'}), 500
        
        # Get match info
        match = log_viewer.db.matches.get_by_id(match_id)
        if not match:
            return jsonify({'error': 'Match not found'}), 404
        
        # Get team details
        home_team = None
        away_team = None
        
        if match.get('team_home'):
            home_team = log_viewer.db.teams.get_by_team_id(match.get('team_home'))
        
        if match.get('team_away'):
            away_team = log_viewer.db.teams.get_by_team_id(match.get('team_away'))
        
        # Get match display name from Citadel API if available
        match_display_name = f"Match {match_id}"
        if log_viewer.citadel:
            try:
                match_data = await log_viewer.citadel.get_match_info(match_id)
                if match_data:
                    home_name = match_data.get('home_team_name', 'TBD')
                    away_name = match_data.get('away_team_name', 'TBD')
                    round_name = match_data.get('round_name', 'Round TBD')
                    season_name = match_data.get('season_name', 'Season TBD')
                    match_display_name = f"{home_name} vs {away_name} ({round_name}, {season_name})"
            except Exception as e:
                logger.warning(f"Could not get match info from Citadel: {e}")
        
        return jsonify({
            'match_id': match_id,
            'display_name': match_display_name,
            'division': match.get('division'),
            'league_id': match.get('league_id'),
            'home_team': {
                'team_id': match.get('team_home'),
                'team_name': home_team.get('team_name') if home_team else f"Team {match.get('team_home')}",
                'roster_id': home_team.get('roster_id') if home_team else None,
                'role_id': home_team.get('role_id') if home_team else None
            } if match.get('team_home') else None,
            'away_team': {
                'team_id': match.get('team_away'), 
                'team_name': away_team.get('team_name') if away_team else f"Team {match.get('team_away')}",
                'roster_id': away_team.get('roster_id') if away_team else None,
                'role_id': away_team.get('role_id') if away_team else None
            } if match.get('team_away') else None
        })
        
    except Exception as e:
        logger.error(f"Error getting match details: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/stats')
async def get_stats():
    """Get database statistics"""
    try:
        stats = {
            'total_logs': 0,
            'total_matches': 0,
            'total_teams': 0,
            'total_synced_users': 0,
            'discord_resolution': False
        }
        
        if log_viewer.db:
            try:
                # Get log counts
                total_logs_count = log_viewer.db.logs._fetch_scalar("SELECT COUNT(*) FROM logs")
                stats['total_logs'] = total_logs_count or 0
                
                # Get match counts
                total_matches_count = log_viewer.db.matches._fetch_scalar("SELECT COUNT(*) FROM matches")
                stats['total_matches'] = total_matches_count or 0
                
                # Get team counts
                total_teams_count = log_viewer.db.teams._fetch_scalar("SELECT COUNT(*) FROM teams")
                stats['total_teams'] = total_teams_count or 0
                
                # Get synced user counts
                stats['total_synced_users'] = len(log_viewer.db.synced_users.get_all())
                
                # Get recent activity (logs from last 24 hours)
                recent_logs_count = log_viewer.db.logs._fetch_scalar(
                    "SELECT COUNT(*) FROM logs WHERE log_timestamp >= DATE_SUB(NOW(), INTERVAL 24 HOUR)"
                )
                stats['recent_activity'] = recent_logs_count or 0
                
            except Exception as e:
                logger.warning(f"Error getting database stats: {e}")
                
        return jsonify(stats)
        
    except Exception as e:
        logger.error(f"Error getting stats: {e}")
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    port = int(os.getenv('WEB_PORT', 8080))
    host = os.getenv('WEB_HOST', '127.0.0.1')
    
    print(f"🌐 Starting simple log viewer on {host}:{port}")
    print("📝 Note: This version does not resolve Discord user IDs")
    print("🔗 Access at: http://localhost:8080")
    
    app.run(host=host, port=port, debug=False)