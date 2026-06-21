"""Admin panel blueprint for Drawbridge web interface."""

import os
import time
import json
import uuid
import asyncio
import discord
from quart import Blueprint, render_template, request, jsonify, redirect, make_response
from modules.logging_config import get_logger
from modules.Drawbridge.checks import Checks

logger = get_logger('drawbridge.web.admin', 'web.log')
checks = Checks()

admin_bp = Blueprint('admin', __name__, url_prefix='/admin')

# Injected at startup from app.py
_bot = None
_db = None
_cit = None
_tournament_cog = None
_sync_cog = None

# Warned users tracking for tournament end
_warned_users: dict[str, float] = {}

# ── Discord API rate-limit helpers ────────────────────────────
_DISCORD_OP_DELAY = 0.75  # seconds between Discord API writes


async def _discord_safe(coro, retries=3):
    """Execute a Discord API call with rate-limit awareness.
    Automatically sleeps ``_DISCORD_OP_DELAY`` after success,
    and retries on 429 with ``retry_after`` respect.
    """
    for attempt in range(retries):
        try:
            result = await coro
            await asyncio.sleep(_DISCORD_OP_DELAY)
            return result
        except discord.HTTPException as e:
            if e.status == 429:
                retry_after = getattr(e, 'retry_after', 1.0)
                logger.warning(f'Discord 429 on attempt {attempt + 1}, retrying in {retry_after}s')
                await asyncio.sleep(retry_after + 0.5)
                continue
            raise
    raise RuntimeError(f'Discord API call failed after {retries} retries (rate limited)')


# ── Background task tracking ──────────────────────────────────
_tasks: dict[str, dict] = {}


def _start_task(coro_factory):
    """Start ``coro_factory(progress_cb)`` as a background asyncio task.
    Returns a task ID string.  The factory receives a callable with
    signature ``(progress: int, message: str) -> None``.
    """
    task_id = str(uuid.uuid4())
    _tasks[task_id] = {
        'id': task_id,
        'status': 'running',
        'progress': 0,
        'message': 'Starting...',
        'result': None,
        'error': None,
    }

    async def _run():
        try:
            def progress_cb(p, m):
                t = _tasks.get(task_id)
                if t:
                    if p is not None:
                        t['progress'] = p
                    if m is not None:
                        t['message'] = m
            result = await coro_factory(progress_cb)
            _tasks[task_id].update({'status': 'completed', 'progress': 100, 'message': 'Complete', 'result': result})
        except Exception as e:
            _tasks[task_id].update({'status': 'failed', 'error': str(e)})
            logger.error(f'Task {task_id} failed: {e}', exc_info=True)

    asyncio.ensure_future(_run())
    return task_id


def initialize(bot, db, cit, tournament_cog, sync_cog):
    global _bot, _db, _cit, _tournament_cog, _sync_cog
    _bot = bot
    _db = db
    _cit = cit
    _tournament_cog = tournament_cog
    _sync_cog = sync_cog
    template_set_db(db)

    if _db:
        try:
            from web.awards_discord import register_views
            register_views(_bot, _db)
            logger.info('Awards persistent views registered')
        except Exception as e:
            logger.warning(f'Failed to register awards views: {e}')

        try:
            from web.match_schedule_discord import register_match_schedule_views
            register_match_schedule_views(_bot, _db)
            logger.info('Match schedule persistent views registered')
        except Exception as e:
            logger.warning(f'Failed to register match schedule views: {e}')


# ── Session helpers ──────────────────────────────────────────
from web.admin_auth import create_session, verify_session, get_oauth2_url, exchange_code, fetch_discord_user
from web.template_helper import get_template, set_db as template_set_db

SESSION_COOKIE = 'drawbridge_admin_session'


def get_session_user():
    token = request.cookies.get(SESSION_COOKIE, '')
    return verify_session(token)


def require_admin(f):
    async def wrapper(*args, **kwargs):
        session_user = get_session_user()
        if not session_user or not session_user.get('is_admin'):
            return jsonify({'error': 'Unauthorized'}), 401
        return await f(*args, **kwargs)
    wrapper.__name__ = f.__name__
    return wrapper


@admin_bp.route('/api/tasks/<task_id>')
@require_admin
async def api_task_status(task_id):
    task = _tasks.get(task_id)
    if not task:
        return jsonify({'error': 'Task not found'}), 404
    return jsonify(task)


def _check_bot_ready():
    if not _bot:
        logger.warning('_check_bot_ready: _bot is None')
        return False
    if not _bot.is_ready():
        logger.debug('_check_bot_ready: bot not ready yet')
        return False
    if not _db:
        logger.warning('_check_bot_ready: _db is None')
        return False
    if not _cit:
        logger.warning('_check_bot_ready: _cit is None')
        return False
    return True


def _get_cog(name: str):
    """Get a cog by name, with fallback search. Returns None if not found."""
    if not _bot:
        return None
    cog = _bot.get_cog(name)
    if cog is not None:
        return cog
    # Fallback: search all cogs case-insensitively or by class name suffix
    for cog_name, cog_instance in _bot.cogs.items():
        if cog_name.lower() == name.lower():
            return cog_instance
        if cog_instance.__class__.__name__ == name:
            return cog_instance
    logger.warning(f'Cog "{name}" not found. Available cogs: {list(_bot.cogs.keys())}')
    return None


def _get_tournament_cog():
    global _tournament_cog
    if _tournament_cog is None:
        _tournament_cog = _get_cog('Tournament')
    return _tournament_cog


def _get_sync_cog():
    global _sync_cog
    if _sync_cog is None:
        _sync_cog = _get_cog('Sync')
    return _sync_cog


def _get_guild():
    guild_id = int(os.getenv('DISCORD_GUILD_ID', 0))
    return _bot.get_guild(guild_id)


def _get_member_roles(user_id: int) -> list[int]:
    guild = _get_guild()
    if not guild:
        return []
    member = guild.get_member(user_id)
    if not member:
        return []
    return [r.id for r in member.roles if r.name != '@everyone']


def _user_has_admin_role(user_id: int) -> bool:
    role_ids = _get_member_roles(user_id)
    admin_keywords = ['DIRECTOR', 'HEAD', 'ADMIN', 'TRIAL', 'DEVELOPER']
    for keyword in admin_keywords:
        admin_role_ids = checks._get_role_ids(keyword)
        if any(rid in role_ids for rid in admin_role_ids):
            return True
    return False


# ── Auth routes ──────────────────────────────────────────────

@admin_bp.route('/login')
async def login_page():
    session_user = get_session_user()
    if session_user and session_user.get('is_admin'):
        return redirect('/admin/dashboard')
    return await render_template('admin/login.html', oauth_url=get_oauth2_url())


@admin_bp.route('/auth/discord')
async def auth_discord():
    return redirect(get_oauth2_url())


@admin_bp.route('/auth/discord/callback')
async def auth_discord_callback():
    code = request.args.get('code', '')
    if not code:
        return jsonify({'error': 'No authorization code provided'}), 400

    token_data = exchange_code(code)
    if not token_data or 'access_token' not in token_data:
        return jsonify({'error': 'Failed to exchange authorization code'}), 400

    discord_user = fetch_discord_user(token_data['access_token'])
    if not discord_user:
        return jsonify({'error': 'Failed to fetch user info'}), 400

    user_id = int(discord_user['id'])

    if not _check_bot_ready():
        return jsonify({'error': 'Bot is not ready. Please try again shortly.'}), 503

    if not _user_has_admin_role(user_id):
        return await render_template('admin/login.html',
                                     error='You do not have admin access to this panel.',
                                     oauth_url=get_oauth2_url())

    is_admin = _user_has_admin_role(user_id)
    session_token = create_session(
        user_id=user_id,
        username=discord_user.get('global_name') or discord_user.get('username', 'Unknown'),
        avatar=discord_user.get('avatar', ''),
        is_admin=is_admin
    )

    response = await make_response(redirect('/admin/dashboard'))
    response.set_cookie(
        SESSION_COOKIE, session_token,
        max_age=900, httponly=True, samesite='Lax',
        secure=True
    )
    return response


@admin_bp.route('/auth/logout')
async def auth_logout():
    response = await make_response(redirect('/admin/login'))
    response.delete_cookie(SESSION_COOKIE)
    return response


@admin_bp.route('/api/auth/me')
async def auth_me():
    session_user = get_session_user()
    if not session_user:
        return jsonify({'authenticated': False}), 401
    return jsonify({
        'authenticated': True,
        'user': {
            'id': session_user['sub'],
            'username': session_user['username'],
            'avatar': session_user['avatar'],
            'is_admin': session_user.get('is_admin', False)
        }
    })


# ── Page routes ──────────────────────────────────────────────

@admin_bp.route('/dashboard')
async def dashboard_page():
    session_user = get_session_user()
    if not session_user or not session_user.get('is_admin'):
        return redirect('/admin/login')
    return await render_template('admin/dashboard.html', user=session_user)


@admin_bp.route('/launchpad')
async def launchpad_page():
    session_user = get_session_user()
    if not session_user or not session_user.get('is_admin'):
        return redirect('/admin/login')
    return await render_template('admin/launchpad.html', user=session_user)


@admin_bp.route('/tournaments')
async def tournaments_page():
    session_user = get_session_user()
    if not session_user or not session_user.get('is_admin'):
        return redirect('/admin/login')
    return await render_template('admin/tournaments.html', user=session_user)


@admin_bp.route('/tournament/<int:league_id>')
async def tournament_detail_page(league_id: int):
    session_user = get_session_user()
    if not session_user or not session_user.get('is_admin'):
        return redirect('/admin/login')
    return await render_template('admin/tournament_detail.html', user=session_user, league_id=league_id)


@admin_bp.route('/matches')
async def matches_page():
    session_user = get_session_user()
    if not session_user or not session_user.get('is_admin'):
        return redirect('/admin/login')
    return await render_template('admin/matches.html', user=session_user)


@admin_bp.route('/logs')
async def admin_logs_page():
    session_user = get_session_user()
    if not session_user or not session_user.get('is_admin'):
        return redirect('/admin/login')
    return await render_template('admin/logs.html', user=session_user)


@admin_bp.route('/sync')
async def sync_page():
    session_user = get_session_user()
    if not session_user or not session_user.get('is_admin'):
        return redirect('/admin/login')
    return await render_template('admin/sync.html', user=session_user)


@admin_bp.route('/templates')
async def templates_page():
    session_user = get_session_user()
    if not session_user or not session_user.get('is_admin'):
        return redirect('/admin/login')
    return await render_template('admin/templates.html', user=session_user)


# ── API endpoints ────────────────────────────────────────────

@admin_bp.route('/api/info')
@require_admin
async def api_admin_info():
    if not _check_bot_ready():
        return jsonify({'error': 'Bot not ready'}), 503
    guild = _get_guild()
    info = {
        'bot': {
            'user': str(_bot.user),
            'id': _bot.user.id,
            'latency': round(_bot.latency * 1000, 1),
        },
        'guild': {
            'name': guild.name if guild else None,
            'id': guild.id if guild else None,
            'member_count': guild.member_count if guild else 0,
        }
    }
    if _db:
        try:
            total_logs = _db.logs._fetch_scalar("SELECT COUNT(*) FROM logs") or 0
            total_matches = _db.matches._fetch_scalar("SELECT COUNT(*) FROM matches") or 0
            total_teams = _db.teams._fetch_scalar("SELECT COUNT(*) FROM teams") or 0
            synced_users = len(_db.synced_users.get_all()) if hasattr(_db.synced_users, 'get_all') else 0
            active_leagues = _db.matches._fetch_scalar(
                "SELECT COUNT(DISTINCT league_id) FROM matches WHERE archived = 0"
            ) or 0
            info['stats'] = {
                'total_logs': total_logs,
                'total_matches': total_matches,
                'total_teams': total_teams,
                'synced_users': synced_users,
                'active_leagues': active_leagues,
            }
        except Exception as e:
            logger.warning(f'Failed to fetch stats: {e}')
            info['stats'] = {}
    return jsonify(info)


# Tournament API

@admin_bp.route('/api/tournament/launchpad', methods=['POST'])
@require_admin
async def api_tournament_launchpad():
    if not _check_bot_ready():
        logger.warning('api_tournament_launchpad: bot not ready')
        return jsonify({'error': 'Bot is not ready yet'}), 503
    cog = _get_tournament_cog()
    if not cog:
        logger.warning('api_tournament_launchpad: tournament cog not found')
        return jsonify({'error': 'Tournament cog not found. Check logs for available cogs.'}), 503
    try:
        guild = _get_guild()
        if not guild:
            return jsonify({'error': 'Guild not found'}), 500
        await cog.update_launchpad()
        return jsonify({'success': True, 'message': 'Launchpad generated and sent to launchpad channel.'})
    except Exception as e:
        logger.error(f'Launchpad error: {e}')
        return _db_error(e)


@admin_bp.route('/api/tournament/start', methods=['POST'])
@require_admin
async def api_tournament_start():
    if not _check_bot_ready() or not _get_tournament_cog():
        return jsonify({'error': 'Bot or tournament cog not ready'}), 503
    data = await request.get_json()
    league_id = data.get('league_id')
    league_shortcode = data.get('league_shortcode')
    role_overrides = data.get('role_overrides')
    if not league_id or not league_shortcode:
        return jsonify({'error': 'league_id and league_shortcode are required'}), 400

    async def _run(p):
        p(0, 'Starting tournament creation...')
        guild = _get_guild()
        league = _cit.getLeague(league_id)
        rosters = league.rosters
        divs = []
        for roster in rosters:
            if roster['division'] not in divs:
                divs.append(roster['division'])

        try:
            existing = _db.leagues.get_by_id(league_id)
            if existing:
                _db.leagues.update(league_id, {'league_name': league.name, 'league_shortcode': league_shortcode})
            else:
                _db.leagues.insert({
                    'league_id': league_id,
                    'league_name': league.name,
                    'league_shortcode': league_shortcode,
                })
        except Exception as e:
            logger.warning(f'Failed to seed league {league_id}: {e}')

        rawteammessage = get_template('teams.json')

        r = 0
        d = 0
        total_divs = len(divs)
        for div in divs:
            d += 1
            p(int(10 + (d / total_divs) * 55), f'Creating division {d}/{total_divs}: {div}...')
            overrides = {
                guild.default_role: discord.PermissionOverwrite(view_channel=False)
            }
            all_access = checks._get_role_ids('HEAD', 'ADMIN', '!AC', 'TRIAL', 'DEVELOPER', 'APPROVED', '!UNAPPROVED', 'BOT')
            for role_id in all_access:
                role_obj = guild.get_role(role_id)
                if role_obj:
                    overrides[role_obj] = discord.PermissionOverwrite(view_channel=True, send_messages=True)
            extra_overrides = _get_tournament_cog().get_role_ids_from_overrides(role_overrides)
            for override in extra_overrides:
                overrides[override] = discord.PermissionOverwrite(view_channel=True, send_messages=True)

            category = await _discord_safe(guild.create_category(f'{div} - {league_shortcode}', overwrites=overrides))
            role = await _discord_safe(guild.create_role(name=f'{div} - {league_shortcode}'))
            dbdiv = {
                'league_id': league_id,
                'division_name': div,
                'role_id': role.id,
                'category_id': category.id,
            }
            divid = _db.divisions.insert(dbdiv)

            teams_in_div = [ros for ros in rosters if ros['division'] == div]
            total_teams = len(teams_in_div)
            for idx, roster in enumerate(teams_in_div):
                r += 1
                p(int(10 + (d - 1) / total_divs * 55 + (idx + 1) / total_teams * (55 / total_divs)),
                  f'Creating team {r} ({roster["name"][:20]})...')
                roster_name = roster['name'][:50]
                role = await _discord_safe(guild.create_role(name=f'{roster_name[:20]} ({league_shortcode})', mentionable=True))
                overwrites = {
                    guild.default_role: discord.PermissionOverwrite(view_channel=False, send_messages=False),
                    role: discord.PermissionOverwrite(view_channel=True, send_messages=True),
                }
                for role_id in all_access:
                    role_obj = guild.get_role(role_id)
                    if role_obj:
                        overwrites[role_obj] = discord.PermissionOverwrite(view_channel=True, send_messages=True)
                for override in extra_overrides:
                    overwrites[override] = discord.PermissionOverwrite(view_channel=True, send_messages=True)
                channel_name = f'🛡️{roster_name[:20]} ({league_shortcode})'
                team_channel = await _discord_safe(guild.create_text_channel(channel_name, category=category, overwrites=overwrites))
                subs = {
                    '{TEAM_MENTION}': f'<@&{role.id}>',
                    '{TEAM_NAME}': roster_name,
                    '{TEAM_ID}': str(roster['team_id']),
                    '{DIVISION}': div,
                    '{LEAGUE_NAME}': league.name,
                    '{LEAGUE_SHORTCODE}': league_shortcode,
                    '{CHANNEL_ID}': str(team_channel.id),
                    '{CHANNEL_LINK}': f'<#{team_channel.id}>',
                }
                from modules.Drawbridge.functions import Functions
                funcs = Functions(_db, _cit)
                team_msg = json.loads(funcs.substitute_strings_in_embed(str(rawteammessage), subs))
                team_msg['embed'] = discord.Embed(**team_msg['embeds'][0])
                del team_msg['embeds']
                await _discord_safe(team_channel.send(**team_msg))
                _db.teams.insert({
                    'roster_id': roster['id'],
                    'team_id': roster['team_id'],
                    'league_id': league_id,
                    'role_id': role.id,
                    'team_channel': team_channel.id,
                    'division': divid,
                    'team_name': roster_name,
                })

        p(75, 'Assigning roles...')
        from modules.Drawbridge.functions import Functions as Funcs
        err_msg = await _get_tournament_cog()._assign_roles(league_id)
        p(90, 'Updating launchpad...')
        await _get_tournament_cog().update_launchpad()
        return {'success': True, 'message': f'Tournament started. Divisions: {d}, Teams: {r}.', 'errors': err_msg}

    task_id = _start_task(_run)
    return jsonify({'task_id': task_id}), 202


@admin_bp.route('/api/tournament/assign-roles', methods=['POST'])
@require_admin
async def api_tournament_assign_roles():
    if not _check_bot_ready() or not _get_tournament_cog():
        return jsonify({'error': 'Bot or tournament cog not ready'}), 503
    data = await request.get_json()
    league_id = data.get('league_id')
    if not league_id:
        return jsonify({'error': 'league_id is required'}), 400

    async def _run(p):
        p(10, 'Assigning roles...')
        err_msg = await _get_tournament_cog()._assign_roles(league_id)
        return {'success': True, 'message': 'Roles assigned.', 'errors': err_msg}

    task_id = _start_task(_run)
    return jsonify({'task_id': task_id}), 202


@admin_bp.route('/api/tournament/assign-captain-roles', methods=['POST'])
@require_admin
async def api_tournament_assign_captain_roles():
    if not _check_bot_ready() or not _get_tournament_cog():
        return jsonify({'error': 'Bot or tournament cog not ready'}), 503
    data = await request.get_json()
    league_id = data.get('league_id')
    if not league_id:
        return jsonify({'error': 'league_id is required'}), 400
    try:
        guild = _get_guild()
        assigned = []
        not_in_server = []
        not_linked = []
        missing_role = []
        for team in _db.teams.get_by_league(league_id):
            team_id = team['team_id']
            team_role_id = team['role_id']
            team_role = guild.get_role(team_role_id)
            cit_team = _cit.getTeam(team_id)
            if not cit_team:
                continue
            for user in cit_team.players:
                if not user.get('is_captain'):
                    continue
                if not user.get('discord_id'):
                    if user['name'] not in not_linked:
                        not_linked.append(user['name'])
                    continue
                member = guild.get_member(user['discord_id'])
                if member is None:
                    if user['name'] not in not_in_server:
                        not_in_server.append(user['name'])
                    continue
                if team_role is None:
                    if user['name'] not in missing_role:
                        missing_role.append(f"{user['name']} (team {team_id})")
                    continue
                if team_role not in member.roles:
                    await member.add_roles(team_role, reason='Drawbridge: assign_captain_roles (web panel)')
                    assigned.append(f"{user['name']} -> {team_role.name}")
        return jsonify({
            'success': True,
            'assigned': assigned,
            'not_in_server': not_in_server,
            'not_linked': not_linked,
            'missing_role': missing_role,
        })
    except Exception as e:
        logger.error(f'Assign captain roles error: {e}')
        return _db_error(e)


@admin_bp.route('/api/tournament/end', methods=['POST'])
@require_admin
async def api_tournament_end():
    if not _check_bot_ready() or not _get_tournament_cog():
        return jsonify({'error': 'Bot or tournament cog not ready'}), 503
    data = await request.get_json()
    league_id = data.get('league_id')
    if not league_id:
        return jsonify({'error': 'league_id is required'}), 400
    session_user = get_session_user()
    user_id = session_user['sub']
    now = time.time()
    if user_id not in _warned_users or _warned_users[user_id] < now - 300:
        _warned_users[user_id] = now
        return jsonify({
            'warned': True,
            'message': 'This will archive ALL channels, categories, and roles. Re-submit within 5 minutes to proceed.'
        }), 202
    del _warned_users[user_id]

    async def _run(p):
        p(0, 'Deleting team channels...')
        guild = _get_guild()
        divs = _db.divisions.get_by_league(league_id)
        teams = _db.teams.get_by_league(league_id)
        league_matches = _db.matches.get_by_league(league_id)
        match_channels = [m['channel_id'] for m in league_matches if m.get('channel_id')]

        total = len(teams) + len(match_channels) + len(divs) + len(teams) * 2 or 1
        done = 0
        for channel in guild.channels:
            for team in teams:
                if channel.id == team['team_channel']:
                    await _discord_safe(channel.delete(reason='Tournament ended (web panel)'))
                    done += 1
                    p(int(done / total * 100), 'Deleting channels...')
                    break
            for mcid in match_channels:
                if channel.id == mcid:
                    await _discord_safe(channel.delete(reason='Tournament ended (web panel)'))
                    done += 1
                    p(int(done / total * 100), 'Deleting channels...')
                    break
        p(40, 'Deleting categories...')
        for div in divs:
            for category in guild.categories:
                if category.id == div['category_id']:
                    await _discord_safe(category.delete())
                    done += 1
                    p(int(done / total * 100), 'Deleting categories...')
                    break
        p(60, 'Deleting roles...')
        for role in guild.roles:
            for team in teams:
                if role.id == team['role_id']:
                    await _discord_safe(role.delete())
                    done += 1
                    break
            for div in divs:
                if role.id == div['role_id']:
                    await _discord_safe(role.delete())
                    done += 1
                    break
        p(85, 'Cleaning up database...')
        _db.matches.delete_by_league(league_id)
        _db.teams.delete_by_league(league_id)
        _db.divisions.delete_by_league(league_id)
        _db.leagues.delete(league_id)
        p(95, 'Updating launchpad...')
        await _get_tournament_cog().update_launchpad()
        return {'success': True, 'message': 'Tournament ended and all channels/roles archived.'}

    task_id = _start_task(_run)
    return jsonify({'task_id': task_id}), 202


@admin_bp.route('/api/tournament/matchgen', methods=['POST'])
@require_admin
async def api_tournament_matchgen():
    if not _check_bot_ready() or not _get_tournament_cog():
        return jsonify({'error': 'Bot or tournament cog not ready'}), 503
    data = await request.get_json()
    match_id = data.get('match_id')
    role_overrides = data.get('role_overrides')
    if not match_id:
        return jsonify({'error': 'match_id is required'}), 400
    try:
        match = _cit.getMatch(match_id)
        if not match:
            return jsonify({'error': 'Match not found in Citadel'}), 404
        result = await _get_tournament_cog()._generate_match(match, role_overrides)
        if result:
            return jsonify({'success': True, 'message': 'Match channel generated.'})
        else:
            return jsonify({'success': False, 'message': 'Match already exists or could not be generated.'})
    except Exception as e:
        logger.error(f'Matchgen error: {e}')
        return _db_error(e)


@admin_bp.route('/api/tournament/matchgen-round', methods=['POST'])
@require_admin
async def api_tournament_matchgen_round():
    if not _check_bot_ready() or not _get_tournament_cog():
        return jsonify({'error': 'Bot or tournament cog not ready'}), 503
    data = await request.get_json()
    league_id = data.get('league_id')
    round_number = data.get('round_number')
    role_overrides = data.get('role_overrides')
    if not league_id:
        return jsonify({'error': 'league_id is required'}), 400

    async def _run(p):
        p(0, 'Loading matches...')
        league = _cit.getLeague(league_id)
        matches = league.matches
        filtered = []
        for m in matches:
            import modules.citadel as citadel_module
            pm = citadel_module.Citadel.PartialMatch(m)
            if pm.status == 'confirmed':
                continue
            if round_number is not None and pm.round_number != round_number:
                continue
            if _db.matches.get_by_id(pm.id) is not None:
                continue
            filtered.append(m)
        total = len(filtered)
        if total == 0:
            return {'success': True, 'message': 'No matches to generate (all already generated or completed).', 'generated': 0, 'errors': []}
        c = 0
        errors = []
        for idx, m in enumerate(filtered):
            import modules.citadel as citadel_module2
            pm = citadel_module2.Citadel.PartialMatch(m)
            p(int((idx + 1) / total * 95), f'Generating match {idx + 1}/{total} (ID: {pm.id})...')
            c += 1
            try:
                full = _cit.getMatch(pm.id)
                await _get_tournament_cog()._generate_match(full, role_overrides)
            except discord.HTTPException as e:
                if e.status == 429:
                    retry_after = getattr(e, 'retry_after', 2.0)
                    p(int((idx + 1) / total * 95), f'Rate limited, waiting {retry_after}s before match {pm.id}...')
                    await asyncio.sleep(retry_after + 1.0)
                    try:
                        full = _cit.getMatch(pm.id)
                        await _get_tournament_cog()._generate_match(full, role_overrides)
                    except Exception as e2:
                        errors.append(f'Match {pm.id} (retry): {e2}')
                else:
                    errors.append(f'Match {pm.id}: {e}')
            except Exception as e:
                errors.append(f'Match {pm.id}: {e}')
            await asyncio.sleep(_DISCORD_OP_DELAY)
        return {'success': True, 'generated': c, 'errors': errors}

    task_id = _start_task(_run)
    return jsonify({'task_id': task_id}), 202


@admin_bp.route('/api/tournament/force-matchgen', methods=['POST'])
@require_admin
async def api_tournament_force_matchgen():
    if not _check_bot_ready() or not _get_tournament_cog():
        return jsonify({'error': 'Bot or tournament cog not ready'}), 503
    data = await request.get_json()
    match_id = data.get('match_id')
    role_overrides = data.get('role_overrides')
    if not match_id:
        return jsonify({'error': 'match_id is required'}), 400
    try:
        existing = _db.matches.get_by_id(match_id)
        if existing:
            await _get_tournament_cog()._delete_match(match_id)
        match = _cit.getMatch(match_id)
        if not match:
            return jsonify({'error': 'Match not found'}), 404
        await _get_tournament_cog()._generate_match(match, role_overrides)
        return jsonify({'success': True, 'message': 'Match forcefully regenerated.'})
    except Exception as e:
        logger.error(f'Force matchgen error: {e}')
        return _db_error(e)


@admin_bp.route('/api/tournament/matchend', methods=['POST'])
@require_admin
async def api_tournament_matchend():
    if not _check_bot_ready() or not _get_tournament_cog():
        return jsonify({'error': 'Bot or tournament cog not ready'}), 503
    data = await request.get_json()
    match_id = data.get('match_id')
    if not match_id:
        return jsonify({'error': 'match_id is required'}), 400
    try:
        match = _db.matches.get_by_id(match_id)
        if not match:
            return jsonify({'error': 'Match not found in database. Generate it first.'}), 404
        if match.get('channel_id') == 0:
            return jsonify({'error': 'Match is a bye, cannot end.'}), 400
        if match.get('archived') == 1:
            return jsonify({'error': 'Match already archived.'}), 400
        guild = _get_guild()
        channel = guild.get_channel(match['channel_id'])
        if channel:
            await channel.send('Match has ended. This channel will now be archived.')
            overwrites = channel.overwrites
            for role, perm in overwrites.items():
                if role.id != guild.default_role.id:
                    overwrites[role] = discord.PermissionOverwrite(read_messages=True, send_messages=False)
            await channel.edit(overwrites=overwrites)
        _db.matches.archive_match(match_id)
        await _get_tournament_cog().update_launchpad()
        return jsonify({'success': True, 'message': 'Match ended and archived.'})
    except Exception as e:
        logger.error(f'Matchend error: {e}')
        return _db_error(e)


@admin_bp.route('/api/tournament/random-demo-check', methods=['POST'])
@require_admin
async def api_tournament_random_demo_check():
    if not _check_bot_ready() or not _get_tournament_cog():
        return jsonify({'error': 'Bot or tournament cog not ready'}), 503
    data = await request.get_json()
    league_id = data.get('league_id')
    round_no = data.get('round_no', 0)
    spes_user = data.get('target_user', 0)
    if not league_id:
        return jsonify({'error': 'league_id is required'}), 400
    try:
        import random
        import modules.citadel as citadel_module
        league = _cit.getLeague(league_id)
        if not league:
            return jsonify({'error': 'League not found'}), 404
        if not _db.divisions.get_by_league(league_id):
            return jsonify({'error': 'League not being monitored'}), 400
        player_chosen = None
        match_chosen = None
        db_team = None
        if spes_user == 0:
            matches = [_cit.getMatch(m['id']) for m in league.matches]
            filtered = [m for m in matches if (round_no == 0 or m.round_number == round_no) and m.forfeit_by != 'no_forfeit' and m.away_team is not None]
            if not filtered:
                return jsonify({'error': 'No matches found for this round'}), 404
            random.shuffle(filtered)
            part = filtered[random.randint(0, len(filtered) - 1)]
            match_chosen = _cit.getMatch(part['id'])
            chosen_team = match_chosen.home_team if random.randint(0, 1) == 0 else match_chosen.away_team
            pot_players = chosen_team['players']
            pl_id = pot_players[random.randint(0, len(pot_players) - 1)]
            player_chosen = _cit.getUser(pl_id['id'])
            db_team = _db.teams.get_by_team_id(chosen_team['team_id'])
            if not db_team:
                return jsonify({'error': f'Team {chosen_team["team_id"]} not found in database'}), 404
        else:
            player_chosen = _cit.getUser(spes_user)
            if not player_chosen:
                return jsonify({'error': 'Player not found'}), 404
            for roster in player_chosen.rosters:
                db_team = _db.teams.get_by_team_id(roster['team_id'])
                if db_team and db_team['league_id'] == league_id:
                    break
            if not db_team:
                return jsonify({'error': 'Player not found on a roster in this league'}), 404
            pl_roster = _cit.getRoster(db_team['roster_id'])
            all_matches = pl_roster.matches if hasattr(pl_roster, 'matches') else []
            if not all_matches:
                return jsonify({'error': 'No matches found for this player'}), 404
            part = all_matches[random.randint(0, len(all_matches) - 1)]
            match_chosen = _cit.getMatch(part['id'])
        round_str = str(match_chosen.round_number)
        raw_msg = get_template('democheck.json')
        from modules.Drawbridge.functions import Functions as Funcs
        funcs = Funcs(_db, _cit)
        demo_msg = json.loads(funcs.substitute_strings_in_embed(str(raw_msg), {
            '{CHANNEL_ID}': f'<@&{db_team["role_id"]}>',
            '{TEAM_NAME}': db_team['team_name'],
            '{ROUND_NO}': round_str,
            '{TARGET_NAME}': player_chosen.name,
            '{TARGET_ID}': str(player_chosen.id),
            '{MATCH_ID}': str(match_chosen.id),
        }))
        demo_msg['embed'] = discord.Embed(**demo_msg['embeds'][0])
        del demo_msg['embeds']
        team_channel = _bot.get_channel(db_team['team_channel'])
        if not team_channel:
            return jsonify({'error': 'Team channel not found'}), 404
        await team_channel.send(**demo_msg)
        return jsonify({
            'success': True,
            'message': f'Random demo check announced for {player_chosen.name}.',
            'player': player_chosen.name,
            'team': db_team['team_name'],
            'match_id': match_chosen.id,
        })
    except Exception as e:
        logger.error(f'Demo check error: {e}', exc_info=True)
        return _db_error(e)


# Sync API

@admin_bp.route('/api/sync/users')
@require_admin
async def api_sync_users():
    if not _check_bot_ready() or not _db:
        return jsonify({'error': 'Bot or database not ready'}), 503
    try:
        users = _db.synced_users.get_all() if hasattr(_db.synced_users, 'get_all') else []
        user_list = []
        for u in users:
            guild = _get_guild()
            member = guild.get_member(u.get('discord_id', 0)) if guild else None
            user_list.append({
                'discord_id': u.get('discord_id'),
                'citadel_id': u.get('citadel_id'),
                'steam_id': u.get('steam_id'),
                'in_guild': member is not None,
            })
        return jsonify({'users': user_list})
    except Exception as e:
        logger.error(f'Sync users error: {e}')
        return _db_error(e)


@admin_bp.route('/api/sync/force', methods=['POST'])
@require_admin
async def api_sync_force():
    if not _check_bot_ready() or not _get_sync_cog():
        return jsonify({'error': 'Bot or sync cog not ready'}), 503
    data = await request.get_json()
    discord_id = data.get('discord_id')
    if not discord_id:
        return jsonify({'error': 'discord_id is required'}), 400
    try:
        guild = _get_guild()
        if not guild:
            return jsonify({'error': 'Guild not found'}), 404
        member = guild.get_member(int(discord_id))
        if not member:
            member = await guild.fetch_member(int(discord_id))
        if not member:
            return jsonify({'error': 'Member not found in guild'}), 404
        await _get_sync_cog()._sync_user(member, None)
        return jsonify({'success': True, 'message': f'Force synced user {discord_id}.'})
    except Exception as e:
        logger.error(f'Force sync error: {e}')
        return _db_error(e)


# Leagues list (Citadel + DB status)

@admin_bp.route('/api/leagues')
@require_admin
async def api_admin_leagues():
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    try:
        db_leagues = _db.leagues.get_all()
        league_list = []
        for db_league in db_leagues:
            lid = db_league['league_id']
            name = db_league.get('league_name') or f'League {lid}'
            shortcode = db_league.get('league_shortcode') or ''
            if _cit:
                try:
                    cit_league = _cit.getLeague(lid)
                    name = cit_league.name
                    shortcode = getattr(cit_league, 'shortcode', shortcode) or shortcode
                except Exception:
                    pass
            entry = {
                'id': lid,
                'name': name,
                'shortcode': shortcode,
                'status': 'active',
                'divisions': _db.divisions.count_by_league(lid),
                'teams': _db.teams.count_by_league(lid),
                'matches': _db.matches.count_by_league(lid),
            }
            league_list.append(entry)
        return jsonify({'leagues': league_list})
    except Exception as e:
        logger.error(f'Leagues error: {e}')
        return _db_error(e)


@admin_bp.route('/api/leagues/active')
@require_admin
async def api_admin_leagues_active():
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    try:
        db_leagues = _db.leagues.get_all()
        result = []
        for db_league in db_leagues:
            lid = db_league['league_id']
            name = db_league.get('league_name') or f'League {lid}'
            shortcode = db_league.get('league_shortcode') or ''
            # Try to enrich with Citadel data
            if _cit:
                try:
                    cit_league = _cit.getLeague(lid)
                    name = cit_league.name
                    shortcode = getattr(cit_league, 'shortcode', shortcode) or shortcode
                except Exception:
                    pass
            divisions = _db.divisions.get_by_league(lid)
            div_list = []
            for d in divisions:
                teams = _db.teams.get_by_division(d['id'])
                unarchived_matches = [m for m in _db.matches.get_by_division(d['id']) if not m.get('archived')]
                matches_rich = []
                for m in unarchived_matches:
                    home_team = _db.teams.get_by_team_id(m['team_home']) if m['team_home'] else None
                    away_team = _db.teams.get_by_team_id(m['team_away']) if m.get('team_away') else None
                    matches_rich.append({
                        'match_id': m['match_id'],
                        'home_team': home_team['team_name'] if home_team else f"Team {m['team_home']}",
                        'away_team': away_team['team_name'] if away_team else 'Bye',
                        'channel_id': m['channel_id'],
                        'archived': m['archived'],
                    })
                team_list = [{'roster_id': t['roster_id'], 'team_id': t['team_id'], 'name': t['team_name'], 'channel_id': t['team_channel']} for t in teams]
                div_list.append({
                    'id': d['id'],
                    'name': d['division_name'],
                    'role_id': d['role_id'],
                    'category_id': d['category_id'],
                    'teams': team_list,
                    'matches': matches_rich,
                })
            result.append({
                'id': lid,
                'name': name,
                'shortcode': shortcode,
                'divisions': div_list,
                'team_count': sum(len(d['teams']) for d in div_list),
                'match_count': sum(len(d['matches']) for d in div_list),
                'division_count': len(div_list),
            })
        return jsonify({'leagues': result})
    except Exception as e:
        logger.error(f'Active leagues error: {e}', exc_info=True)
        return _db_error(e)


@admin_bp.route('/api/tournament/<int:league_id>/detail')
@require_admin
async def api_tournament_detail(league_id: int):
    if not _cit or not _db:
        return jsonify({'error': 'Not ready'}), 503
    try:
        league = _cit.getLeague(league_id)
        if not league:
            return jsonify({'error': 'League not found in Citadel'}), 404
        db_league = _db.leagues.get_by_id(league_id)
        divisions = _db.divisions.get_by_league(league_id)
        div_list = []
        for d in divisions:
            teams = _db.teams.get_by_division(d['id'])
            matches = _db.matches.get_by_division(d['id'])
            matches_rich = []
            for m in matches:
                home_team = _db.teams.get_by_team_id(m['team_home']) if m['team_home'] else None
                away_team = _db.teams.get_by_team_id(m['team_away']) if m.get('team_away') else None
                matches_rich.append({
                    'match_id': m['match_id'],
                    'home_team': home_team['team_name'] if home_team else f"Team {m['team_home']}",
                    'away_team': away_team['team_name'] if away_team else 'Bye',
                    'home_team_id': m['team_home'],
                    'away_team_id': m.get('team_away'),
                    'channel_id': m['channel_id'],
                    'archived': m['archived'],
                })
            team_list = [{'roster_id': t['roster_id'], 'team_id': t['team_id'], 'name': t['team_name'], 'channel_id': t['team_channel'], 'role_id': t['role_id']} for t in teams]
            div_list.append({
                'id': d['id'],
                'name': d['division_name'],
                'role_id': d['role_id'],
                'category_id': d['category_id'],
                'teams': team_list,
                'matches': matches_rich,
            })
        return jsonify({
            'id': league.id,
            'name': league.name,
            'shortcode': league.shortcode if hasattr(league, 'shortcode') else '',
            'status': db_league.get('status', 'active') if db_league else 'unknown',
            'divisions': div_list,
        })
    except Exception as e:
        logger.error(f'Tournament detail error: {e}', exc_info=True)
        return _db_error(e)


# Message templates

# Known template names and their default content for display in the admin editor
_KNOWN_TEMPLATE_DEFAULTS: dict[str, str] = {
    'award_nomination_open.txt': '{\n  "content": "{{role_mention}} \U0001f4e2 **Award Nominations are now open!**\\n\\n**Categories to fill in:**\\n{{categories_list}}\\n\\nClick the button below to submit your team\'s nominations.\\nYou can edit your responses by clicking again before nominations close."\n}',
    'award_vote_open.txt': '{\n  "content": "{{role_mention}} \U0001f5f3\ufe0f **Voting is now open!**\\n\\nClick the button below to cast your team\'s votes.\\nYou have one ballot per team. You can edit by clicking again before voting closes."\n}',
}


@admin_bp.route('/api/templates')
@require_admin
async def api_templates_list():
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    try:
        templates = _db.message_templates.get_all() or []
        db_names = {t['template_name'] for t in templates}
        # Include known defaults not yet saved to DB
        for name, default in _KNOWN_TEMPLATE_DEFAULTS.items():
            if name not in db_names:
                templates.append({
                    'template_name': name,
                    'content': default,
                    'updated_at': None,
                })
        return jsonify({'templates': templates})
    except Exception as e:
        err = str(e)
        if "doesn't exist" in err:
            return jsonify({'templates': [], 'note': 'message_templates table not available — run migration 2'})
        logger.error(f'Templates list error: {e}')
        return jsonify({'error': err}), 500


@admin_bp.route('/api/templates/<name>')
@require_admin
async def api_template_get(name: str):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    try:
        template = _db.message_templates.get_by_name(name)
        if not template:
            # Return default content if known
            if name in _KNOWN_TEMPLATE_DEFAULTS:
                return jsonify({
                    'template_name': name,
                    'content': _KNOWN_TEMPLATE_DEFAULTS[name],
                    'updated_at': None,
                })
            return jsonify({'error': 'Template not found'}), 404
        return jsonify(template)
    except Exception as e:
        err = str(e)
        if "doesn't exist" in err:
            return jsonify({'error': 'Table not available'}), 404
        logger.error(f'Template get error: {e}')
        return jsonify({'error': err}), 500


@admin_bp.route('/api/templates/<name>', methods=['PUT'])
@require_admin
async def api_template_update(name: str):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    data = await request.get_json()
    content = data.get('content', '')
    if not content:
        return jsonify({'error': 'Content is required'}), 400
    try:
        _db.message_templates.upsert(name, content)
        logger.info(f'Template "{name}" updated via admin panel')
        return jsonify({'success': True, 'message': f'Template "{name}" updated.'})
    except Exception as e:
        err = str(e)
        if "doesn't exist" in err:
            return jsonify({'error': 'Table not available — run migration 2 to enable'}), 503
        logger.error(f'Template update error: {e}')
        return jsonify({'error': err}), 500


def _db_error(e, default_msg='Database operation failed'):
    """Return appropriate error response for database errors, detecting missing tables."""
    err = str(e)
    if "doesn't exist" in err:
        return jsonify({'error': 'Required database table not available — verify migrations have been applied'}), 503
    return jsonify({'error': err}), 500


# ── Awards Page Routes ───────────────────────────────────────


@admin_bp.route('/awards')
async def awards_page():
    session_user = get_session_user()
    if not session_user or not session_user.get('is_admin'):
        return redirect('/admin/login')
    return await render_template('admin/awards.html', user=session_user)


@admin_bp.route('/awards/<int:event_id>')
async def award_event_page(event_id: int):
    session_user = get_session_user()
    if not session_user or not session_user.get('is_admin'):
        return redirect('/admin/login')
    return await render_template('admin/award_event.html', user=session_user, event_id=event_id)


@admin_bp.route('/awards/<int:event_id>/submissions')
async def award_submissions_page(event_id: int):
    session_user = get_session_user()
    if not session_user or not session_user.get('is_admin'):
        return redirect('/admin/login')
    return await render_template('admin/award_submissions.html', user=session_user, event_id=event_id)


@admin_bp.route('/awards/templates/<int:tmpl_id>')
async def award_template_page(tmpl_id: int):
    session_user = get_session_user()
    if not session_user or not session_user.get('is_admin'):
        return redirect('/admin/login')
    return await render_template('admin/award_template.html', user=session_user, tmpl_id=tmpl_id)


# ── Awards API: Templates ────────────────────────────────────


@admin_bp.route('/api/awards/templates')
@require_admin
async def api_award_templates_list():
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    try:
        templates = _db.award_templates.get_all()
        return jsonify({'templates': templates or []})
    except Exception as e:
        logger.error(f'Award templates list error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/templates', methods=['POST'])
@require_admin
async def api_award_templates_create():
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    data = await request.get_json()
    if not data or 'name' not in data:
        return jsonify({'error': 'name is required'}), 400
    try:
        tmpl_id = _db.award_templates.insert({
            'name': data['name'],
            'description': data.get('description', ''),
            'sort_order': data.get('sort_order', 0),
        })
        return jsonify({'success': True, 'id': tmpl_id}), 201
    except Exception as e:
        logger.error(f'Award template create error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/templates/<int:tmpl_id>')
@require_admin
async def api_award_templates_get(tmpl_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    try:
        tmpl = _db.award_templates.get_by_id(tmpl_id)
        if not tmpl:
            return jsonify({'error': 'Template not found'}), 404
        categories = _db.award_template_categories.get_by_template(tmpl_id)
        return jsonify({**tmpl, 'categories': categories})
    except Exception as e:
        logger.error(f'Award template get error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/templates/<int:tmpl_id>', methods=['PUT'])
@require_admin
async def api_award_templates_update(tmpl_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    data = await request.get_json()
    if not data:
        return jsonify({'error': 'No data provided'}), 400
    try:
        _db.award_templates.update(tmpl_id, data)
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f'Award template update error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/templates/<int:tmpl_id>', methods=['DELETE'])
@require_admin
async def api_award_templates_delete(tmpl_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    try:
        _db.award_template_categories.delete_by_template(tmpl_id)
        _db.award_templates.delete(tmpl_id)
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f'Award template delete error: {e}')
        return _db_error(e)


# ── Awards API: Template Categories ──────────────────────────


@admin_bp.route('/api/awards/templates/<int:tmpl_id>/categories')
@require_admin
async def api_award_template_categories_list(tmpl_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    try:
        cats = _db.award_template_categories.get_by_template(tmpl_id)
        return jsonify({'categories': cats})
    except Exception as e:
        logger.error(f'Template categories list error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/templates/<int:tmpl_id>/categories', methods=['POST'])
@require_admin
async def api_award_template_categories_create(tmpl_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    data = await request.get_json()
    if not data or 'name' not in data:
        return jsonify({'error': 'name is required'}), 400
    try:
        cat_id = _db.award_template_categories.insert({
            'template_id': tmpl_id,
            'name': data['name'],
            'fill_type': data.get('fill_type', 'nomination'),
            'sort_order': data.get('sort_order', 0),
        })
        return jsonify({'success': True, 'id': cat_id}), 201
    except Exception as e:
        logger.error(f'Template category create error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/templates/<int:tmpl_id>/categories/<int:cat_id>', methods=['PUT'])
@require_admin
async def api_award_template_categories_update(tmpl_id: int, cat_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    data = await request.get_json()
    if not data:
        return jsonify({'error': 'No data provided'}), 400
    try:
        _db.award_template_categories.update(cat_id, data)
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f'Template category update error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/templates/<int:tmpl_id>/categories/<int:cat_id>', methods=['DELETE'])
@require_admin
async def api_award_template_categories_delete(tmpl_id: int, cat_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    try:
        _db.award_template_categories.delete(cat_id)
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f'Template category delete error: {e}')
        return _db_error(e)


# ── Awards API: Events ───────────────────────────────────────


@admin_bp.route('/api/awards/events')
@require_admin
async def api_award_events_list():
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    try:
        events = _db.award_events.get_all()
        enriched = []
        for ev in events:
            league = _db.leagues.get_by_id(ev['league_id']) if _db.leagues else None
            cat_count = len(_db.award_event_categories.get_by_event(ev['id']))
            nom_count = _db.award_nominations.count_by_event(ev['id'])
            enriched.append({
                **ev,
                'league_name': league.get('league_name', f"League {ev['league_id']}") if league else f"League {ev['league_id']}",
                'category_count': cat_count,
                'nomination_count': nom_count,
            })
        return jsonify({'events': enriched})
    except Exception as e:
        logger.error(f'Award events list error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/events', methods=['POST'])
@require_admin
async def api_award_events_create():
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    data = await request.get_json()
    if not data or 'league_id' not in data or 'name' not in data:
        return jsonify({'error': 'league_id and name are required'}), 400
    try:
        template_id = data.get('template_id')
        event_id = _db.award_events.insert({
            'league_id': data['league_id'],
            'template_id': template_id,
            'name': data['name'],
            'status': data.get('status', 'pending'),
            'nomination_deadline': data.get('nomination_deadline'),
            'voting_deadline': data.get('voting_deadline'),
        })
        # Copy categories from template to this event
        if template_id:
            tmpl_cats = _db.award_template_categories.get_by_template(template_id)
            for tc in tmpl_cats:
                _db.award_event_categories.insert({
                    'event_id': event_id,
                    'template_category_id': tc['id'],
                    'name': tc['name'],
                    'fill_type': tc['fill_type'],
                    'sort_order': tc.get('sort_order', 0),
                })
        return jsonify({'success': True, 'id': event_id}), 201
    except Exception as e:
        logger.error(f'Award event create error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/events/<int:event_id>')
@require_admin
async def api_award_events_get(event_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    try:
        ev = _db.award_events.get_by_id(event_id)
        if not ev:
            return jsonify({'error': 'Event not found'}), 404
        league = _db.leagues.get_by_id(ev['league_id']) if _db.leagues else None
        categories = _db.award_event_categories.get_by_event(event_id)
        divisions = _db.divisions.get_by_league(ev['league_id'])
        fill_options = _db.award_admin_fill_options.get_by_event(event_id) if hasattr(_db, 'award_admin_fill_options') else []
        fill_opts_by_category: dict[int, list[str]] = {}
        for fo in fill_options:
            fill_opts_by_category.setdefault(fo['category_id'], []).append(fo['option'])

        cat_details = []
        for cat in categories:
            nom_count = len(_db.award_nominations.get_by_event_and_category(event_id, cat['id']))
            vote_count = len(_db.award_votes.get_by_event_and_category(event_id, cat['id']))
            cat_out = {**cat, 'nomination_count': nom_count, 'vote_count': vote_count}
            if cat['fill_type'] == 'admin_fill':
                cat_out['fill_options'] = fill_opts_by_category.get(cat['id'], [])
            cat_details.append(cat_out)
        # Per-division stats
        div_details = []
        for d in divisions:
            teams_in_div = _db.teams.get_by_division(d['id'])
            team_count = len(teams_in_div)
            nom_cats = [c['id'] for c in categories]
            div_noms = _db.award_nominations.get_by_division(d['id'], event_id) if nom_cats else []
            div_votes = _db.award_votes.get_by_division(d['id'], event_id) if nom_cats else []
            teams_nominated = len(set(r['team_id'] for r in div_noms))
            teams_voted = len(set(r['team_id'] for r in div_votes))
            div_details.append({
                'id': d['id'],
                'name': d['division_name'],
                'team_count': team_count,
                'teams_nominated': teams_nominated,
                'teams_voted': teams_voted,
            })
        return jsonify({
            **ev,
            'league_name': league.get('league_name', f"League {ev['league_id']}") if league else f"League {ev['league_id']}",
            'categories': cat_details,
            'divisions': div_details,
        })
    except Exception as e:
        logger.error(f'Award event get error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/events/<int:event_id>/status', methods=['PUT'])
@require_admin
async def api_award_events_set_status(event_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    data = await request.get_json()
    status = data.get('status', '') if data else ''
    valid = ('pending', 'nominations', 'nominations_closed', 'voting', 'voting_closed', 'calculating', 'complete', 'cancelled')
    if status not in valid:
        return jsonify({'error': f'Invalid status. Valid: {", ".join(valid)}'}), 400
    try:
        _db.award_events.set_status(event_id, status)
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f'Award event status error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/events/<int:event_id>/close-nominations', methods=['POST'])
@require_admin
async def api_award_events_close_nominations(event_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    try:
        ev = _db.award_events.get_by_id(event_id)
        if not ev:
            return jsonify({'error': 'Event not found'}), 404
        _db.award_events.set_status(event_id, 'nominations_closed')
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f'Close nominations error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/events/<int:event_id>/close-voting', methods=['POST'])
@require_admin
async def api_award_events_close_voting(event_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    try:
        ev = _db.award_events.get_by_id(event_id)
        if not ev:
            return jsonify({'error': 'Event not found'}), 404
        _db.award_events.set_status(event_id, 'voting_closed')
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f'Close voting error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/events/<int:event_id>', methods=['DELETE'])
@require_admin
async def api_award_events_delete(event_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    try:
        ev = _db.award_events.get_by_id(event_id)
        if not ev:
            return jsonify({'error': 'Event not found'}), 404
        # Clean up related data
        if hasattr(_db, 'award_results'):
            _db.award_results.delete_by_event(event_id)
        if hasattr(_db, 'award_admin_fill_options'):
            _db.award_admin_fill_options.delete_by_event(event_id)
        if hasattr(_db, 'award_votes'):
            _db.award_votes.delete_by_event(event_id)
        if hasattr(_db, 'award_nominations'):
            _db.award_nominations.delete_by_event(event_id)
        cats = _db.award_event_categories.get_by_event(event_id)
        for cat in cats:
            _db.award_event_categories.delete(cat['id'])
        _db.award_events.delete(event_id)
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f'Delete event error: {e}')
        return _db_error(e)


# ── Awards API: Categories ───────────────────────────────────


@admin_bp.route('/api/awards/events/<int:event_id>/categories', methods=['POST'])
@require_admin
async def api_award_categories_create(event_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    data = await request.get_json()
    if not data or 'name' not in data:
        return jsonify({'error': 'name is required'}), 400
    try:
        cat_id = _db.award_event_categories.insert({
            'event_id': event_id,
            'template_id': data.get('template_id'),
            'name': data['name'],
            'phase': data.get('phase', 'nomination'),
            'fill_type': data.get('fill_type', 'manual'),
            'sort_order': data.get('sort_order', 0),
        })
        return jsonify({'success': True, 'id': cat_id}), 201
    except Exception as e:
        logger.error(f'Award category create error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/events/<int:event_id>/categories/<int:cat_id>', methods=['PUT'])
@require_admin
async def api_award_categories_update(event_id: int, cat_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    data = await request.get_json()
    if not data:
        return jsonify({'error': 'No data provided'}), 400
    try:
        _db.award_event_categories.update(cat_id, data)
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f'Award category update error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/events/<int:event_id>/categories/<int:cat_id>', methods=['DELETE'])
@require_admin
async def api_award_categories_delete(event_id: int, cat_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    try:
        _db.award_nominations.delete_by_category(cat_id)
        _db.award_votes.delete_by_category(cat_id)
        _db.award_event_categories.delete(cat_id)
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f'Award category delete error: {e}')
        return _db_error(e)


# ── Awards API: Nominations & Votes ──────────────────────────


_username_cache: dict[int, str] = {}


async def _resolve_username(user_id: int) -> str:
    if user_id in _username_cache:
        return _username_cache[user_id]
    try:
        if _bot:
            user = await _bot.fetch_user(user_id)
            name = str(user)
            _username_cache[user_id] = name
            return name
    except Exception:
        pass
    return str(user_id)


async def _enrich_nomination(n, db):
    cat = db.award_event_categories.get_by_id(n['category_id'])
    team = db.teams.get_by_team_id(n['team_id'])
    div_name = ''
    if team:
        div = db.divisions.get_by_id(team['division'])
        div_name = div['division_name'] if div else ''
    username = await _resolve_username(n['submitted_by'])
    return {
        **n,
        'category_name': cat['name'] if cat else f"Category {n['category_id']}",
        'team_name': team['team_name'] if team else f"Team {n['team_id']}",
        'division_name': div_name,
        'submitted_by_name': username,
    }


@admin_bp.route('/api/awards/events/<int:event_id>/nominations')
@require_admin
async def api_award_nominations_list(event_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    try:
        noms = _db.award_nominations.get_by_event(event_id)
        enriched = [await _enrich_nomination(n, _db) for n in noms]
        return jsonify({'nominations': enriched})
    except Exception as e:
        logger.error(f'Award nominations list error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/events/<int:event_id>/nominations/<int:nom_id>/edit', methods=['PUT'])
@require_admin
async def api_award_nominations_edit(event_id: int, nom_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    data = await request.get_json()
    session_user = get_session_user()
    new_response = (data.get('response') or '').strip() if data else ''
    if not new_response:
        return jsonify({'error': 'response is required'}), 400
    try:
        nom = _db.award_nominations.get_by_id(nom_id)
        if not nom:
            return jsonify({'error': 'Nomination not found'}), 404
        old_value = nom.get('response', '')
        _db.award_nominations.update(nom_id, {
            'response': new_response,
            'status': 'accepted',
            'invalidated_by': None,
            'invalidated_at': None,
            'invalidation_reason': None,
        })
        _db.award_nomination_audit_log.insert({
            'nomination_id': nom_id,
            'action': 'edit',
            'admin_user_id': session_user['sub'],
            'admin_username': session_user.get('username', ''),
            'old_value': old_value,
            'new_value': new_response,
            'reason': data.get('reason', ''),
        })
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f'Award nomination edit error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/events/<int:event_id>/nominations/<int:nom_id>/invalidate', methods=['PUT'])
@require_admin
async def api_award_nominations_invalidate(event_id: int, nom_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    data = await request.get_json()
    reason = data.get('reason', '') if data else ''
    session_user = get_session_user()
    try:
        nom = _db.award_nominations.get_by_id(nom_id)
        if not nom:
            return jsonify({'error': 'Nomination not found'}), 404
        _db.award_nominations.set_status(nom_id, 'rejected', session_user['sub'], reason)
        _db.award_nomination_audit_log.insert({
            'nomination_id': nom_id,
            'action': 'invalidate',
            'admin_user_id': session_user['sub'],
            'admin_username': session_user.get('username', ''),
            'old_value': nom.get('response', ''),
            'new_value': '',
            'reason': reason,
        })
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f'Award nomination invalidate error: {e}')
        return _db_error(e)


async def _enrich_vote(v, db):
    cat = db.award_event_categories.get_by_id(v['category_id'])
    team = db.teams.get_by_team_id(v['team_id'])
    div_name = ''
    if team:
        div = db.divisions.get_by_id(team['division'])
        div_name = div['division_name'] if div else ''
    username = await _resolve_username(v['submitted_by'])
    return {
        **v,
        'category_name': cat['name'] if cat else f"Category {v['category_id']}",
        'team_name': team['team_name'] if team else f"Team {v['team_id']}",
        'division_name': div_name,
        'submitted_by_name': username,
    }


@admin_bp.route('/api/awards/events/<int:event_id>/votes')
@require_admin
async def api_award_votes_list(event_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    try:
        votes = _db.award_votes.get_by_event(event_id)
        enriched = [await _enrich_vote(v, _db) for v in votes]
        return jsonify({'votes': enriched})
    except Exception as e:
        logger.error(f'Award votes list error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/events/<int:event_id>/votes/<int:vote_id>/invalidate', methods=['PUT'])
@require_admin
async def api_award_votes_invalidate(event_id: int, vote_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    data = await request.get_json()
    reason = data.get('reason', '') if data else ''
    session_user = get_session_user()
    try:
        vote = _db.award_votes.get_by_id(vote_id)
        if not vote:
            return jsonify({'error': 'Vote not found'}), 404
        _db.award_votes.set_status(vote_id, 'rejected', session_user['sub'], reason)
        _db.award_vote_audit_log.insert({
            'vote_id': vote_id,
            'action': 'invalidate',
            'admin_user_id': session_user['sub'],
            'admin_username': session_user.get('username', ''),
            'old_value': f"{vote.get('choice_1', '')} / {vote.get('choice_2', '')} / {vote.get('choice_3', '')}",
            'new_value': '',
            'reason': reason,
        })
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f'Award vote invalidate error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/events/<int:event_id>/nominations/invalidate-team/<int:team_id>', methods=['POST'])
@require_admin
async def api_award_nominations_invalidate_team(event_id: int, team_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    data = await request.get_json()
    reason = data.get('reason', '') if data else ''
    session_user = get_session_user()
    try:
        noms = _db.award_nominations.get_by_team_and_event(team_id, event_id)
        if not noms:
            return jsonify({'error': 'No nominations found for this team'}), 404
        count = 0
        for nom in noms:
            _db.award_nominations.set_status(nom['id'], 'rejected', session_user['sub'], reason)
            _db.award_nomination_audit_log.insert({
                'nomination_id': nom['id'],
                'action': 'invalidate',
                'admin_user_id': session_user['sub'],
                'admin_username': session_user.get('username', ''),
                'old_value': nom.get('response', ''),
                'new_value': '',
                'reason': reason,
            })
            count += 1
        return jsonify({'success': True, 'invalidated': count})
    except Exception as e:
        logger.error(f'Award nominations invalidate team error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/events/<int:event_id>/votes/invalidate-team/<int:team_id>', methods=['POST'])
@require_admin
async def api_award_votes_invalidate_team(event_id: int, team_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    data = await request.get_json()
    reason = data.get('reason', '') if data else ''
    session_user = get_session_user()
    try:
        votes = _db.award_votes.get_by_team_and_event(team_id, event_id)
        if not votes:
            return jsonify({'error': 'No votes found for this team'}), 404
        count = 0
        for vote in votes:
            _db.award_votes.set_status(vote['id'], 'rejected', session_user['sub'], reason)
            _db.award_vote_audit_log.insert({
                'vote_id': vote['id'],
                'action': 'invalidate',
                'admin_user_id': session_user['sub'],
                'admin_username': session_user.get('username', ''),
                'old_value': f"{vote.get('choice_1', '')} / {vote.get('choice_2', '')} / {vote.get('choice_3', '')}",
                'new_value': '',
                'reason': reason,
            })
            count += 1
        return jsonify({'success': True, 'invalidated': count})
    except Exception as e:
        logger.error(f'Award votes invalidate team error: {e}')
        return _db_error(e)


# ── Awards API: Calculate & Results ──────────────────────────


@admin_bp.route('/api/awards/events/<int:event_id>/calculate', methods=['POST'])
@require_admin
async def api_award_events_calculate(event_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    try:
        ev = _db.award_events.get_by_id(event_id)
        if not ev:
            return jsonify({'error': 'Event not found'}), 404

        _db.award_events.set_status(event_id, 'calculating')

        from web.irv import calculate_irv

        categories = _db.award_event_categories.get_by_event(event_id)
        divisions = _db.divisions.get_by_league(ev['league_id'])

        # Clear old results
        _db.award_results.delete_by_event(event_id)

        for cat in categories:
            for div in divisions:
                votes = _db.award_votes.get_by_event_and_category(event_id, cat['id'])
                div_votes = [
                    (v.get('choice_1', ''), v.get('choice_2', ''), v.get('choice_3', ''))
                    for v in votes if v.get('division_id') == div['id']
                ]
                if not div_votes:
                    continue
                results = calculate_irv(div_votes, top_n=3)
                for placement, (entry, points) in enumerate(results, 1):
                    _db.award_results.insert({
                        'event_id': event_id,
                        'category_id': cat['id'],
                        'division_id': div['id'],
                        'placement': placement,
                        'entry': entry,
                        'points': points,
                    })

        _db.award_events.set_status(event_id, 'complete')
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f'Award calculate error: {e}')
        _db.award_events.set_status(event_id, 'voting')
        return _db_error(e)


# ── Awards API: Admin Fill Options ───────────────────────────


@admin_bp.route('/api/awards/events/<int:event_id>/fill-options')
@require_admin
async def api_award_fill_options_list(event_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    try:
        options = _db.award_admin_fill_options.get_by_event(event_id)
        return jsonify({'options': options})
    except Exception as e:
        logger.error(f'Admin fill options list error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/events/<int:event_id>/categories/<int:cat_id>/fill-options', methods=['PUT'])
@require_admin
async def api_award_fill_options_update(event_id: int, cat_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    data = await request.get_json()
    options = data.get('options', []) if data else []
    if not isinstance(options, list):
        return jsonify({'error': 'options must be a list of strings'}), 400
    try:
        _db.award_admin_fill_options.delete_by_category(cat_id)
        for opt in options:
            if opt.strip():
                _db.award_admin_fill_options.insert({
                    'event_id': event_id,
                    'category_id': cat_id,
                    'option': opt.strip(),
                })
        return jsonify({'success': True, 'count': len(options)})
    except Exception as e:
        logger.error(f'Admin fill options update error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/events/<int:event_id>/results')
@require_admin
async def api_award_events_results(event_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    try:
        results = _db.award_results.get_by_event(event_id)
        categories = _db.award_event_categories.get_by_event(event_id)
        cat_map = {c['id']: c['name'] for c in categories}
        divisions = {}
        if results:
            div_ids = set(r['division_id'] for r in results)
            for did in div_ids:
                div = _db.divisions.get_by_id(did)
                if div:
                    divisions[did] = div['division_name']

        enriched = []
        for r in results:
            enriched.append({
                **r,
                'category_name': cat_map.get(r['category_id'], f"Cat {r['category_id']}"),
                'division_name': divisions.get(r['division_id'], f"Div {r['division_id']}"),
            })
        return jsonify({'results': enriched})
    except Exception as e:
        logger.error(f'Award results error: {e}')
        return _db_error(e)


# ── Awards API: Send Discord Messages ────────────────────────


@admin_bp.route('/api/awards/events/<int:event_id>/open-nominations', methods=['POST'])
@require_admin
async def api_award_events_open_nominations(event_id: int):
    if not _check_bot_ready():
        return jsonify({'error': 'Bot not ready'}), 503
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    try:
        ev = _db.award_events.get_by_id(event_id)
        if not ev:
            return jsonify({'error': 'Event not found'}), 404
        from web.awards_discord import send_nomination_message
        cats = _db.award_event_categories.get_by_event_and_fill_types(event_id, ['nomination'])
        cat_names = [c['name'] for c in cats] if cats else None
        teams = _db.teams.get_by_league(ev['league_id'])
        sent = 0
        for team in teams:
            if team.get('team_channel') and team.get('role_id'):
                ok = await send_nomination_message(_bot, team['team_channel'],
                                                     team['role_id'], event_id, team['team_id'],
                                                     categories=cat_names)
                if ok:
                    sent += 1
        _db.award_events.set_status(event_id, 'nominations')
        from web.awards_discord import register_views
        register_views(_bot, _db)
        return jsonify({'success': True, 'messages_sent': sent})
    except Exception as e:
        logger.error(f'Open nominations error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/events/<int:event_id>/open-voting', methods=['POST'])
@require_admin
async def api_award_events_open_voting(event_id: int):
    if not _check_bot_ready():
        return jsonify({'error': 'Bot not ready'}), 503
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    try:
        ev = _db.award_events.get_by_id(event_id)
        if not ev:
            return jsonify({'error': 'Event not found'}), 404
        from web.awards_discord import send_vote_message
        teams = _db.teams.get_by_league(ev['league_id'])
        sent = 0
        for team in teams:
            if team.get('team_channel') and team.get('role_id'):
                ok = await send_vote_message(_bot, team['team_channel'],
                                              team['role_id'], event_id, team['team_id'])
                if ok:
                    sent += 1
        _db.award_events.set_status(event_id, 'voting')
        from web.awards_discord import register_views
        register_views(_bot, _db)
        return jsonify({'success': True, 'messages_sent': sent})
    except Exception as e:
        logger.error(f'Open voting error: {e}')
        return _db_error(e)


@admin_bp.route('/api/leagues/<int:league_id>/schedule-settings')
@require_admin
async def api_schedule_settings_get(league_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    try:
        settings = _db.tournament_schedule_settings.get_by_league(league_id) if hasattr(_db, 'tournament_schedule_settings') else None
        if settings:
            excluded = [int(x) for x in settings['excluded_days'].split(',') if x.strip()] if settings.get('excluded_days') else []
            return jsonify({'settings': {
                'excluded_days': excluded,
                'scheduling_enabled': bool(settings.get('scheduling_enabled')),
                'format': settings.get('format'),
                'deadline_day': settings.get('deadline_day'),
                'deadline_time': settings.get('deadline_time'),
            }})
        return jsonify({'settings': {
            'excluded_days': [], 'scheduling_enabled': False,
            'format': None, 'deadline_day': None, 'deadline_time': None,
        }})
    except Exception as e:
        logger.error(f'Schedule settings error: {e}')
        return _db_error(e)


@admin_bp.route('/api/leagues/<int:league_id>/schedule-settings', methods=['PUT'])
@require_admin
async def api_schedule_settings_update(league_id: int):
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    data = await request.get_json() or {}
    excluded = data.get('excluded_days', [])
    excluded_str = ','.join(str(d) for d in excluded)
    scheduling_enabled = 1 if data.get('scheduling_enabled') else 0
    fmt = data.get('format') or None
    deadline_day = data.get('deadline_day')
    deadline_time = data.get('deadline_time') or None
    # Fill the deadline from the format preset when not explicitly provided.
    from modules.database.repositories import TournamentScheduleSettingsRepository
    preset = TournamentScheduleSettingsRepository.format_defaults(fmt)
    if preset:
        if deadline_day in (None, ''):
            deadline_day = preset['deadline_day']
        if not deadline_time:
            deadline_time = preset['deadline_time']
    deadline_day = int(deadline_day) if deadline_day not in (None, '') else None
    payload = {
        'excluded_days': excluded_str,
        'scheduling_enabled': scheduling_enabled,
        'format': fmt,
        'deadline_day': deadline_day,
        'deadline_time': deadline_time,
    }
    try:
        existing = _db.tournament_schedule_settings.get_by_league(league_id) if hasattr(_db, 'tournament_schedule_settings') else None
        if existing:
            _db.tournament_schedule_settings.update(existing['id'], payload)
        else:
            _db.tournament_schedule_settings.insert({'league_id': league_id, **payload})
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f'Schedule settings update error: {e}')
        return _db_error(e)


@admin_bp.route('/api/awards/events/<int:event_id>/notify-invalidation', methods=['POST'])
@require_admin
async def api_award_events_notify_invalidation(event_id: int):
    if not _check_bot_ready():
        return jsonify({'error': 'Bot not ready'}), 503
    if not _db:
        return jsonify({'error': 'Database not ready'}), 503
    data = await request.get_json()
    submission_type = data.get('type', 'submission') if data else 'submission'
    reason = data.get('reason') if data else None
    team_id = data.get('team_id') if data else None
    if not team_id:
        return jsonify({'error': 'team_id is required'}), 400
    try:
        from web.awards_discord import send_invalidation_notification
        team = _db.teams.get_by_team_id(team_id)
        if not team:
            return jsonify({'error': 'Team not found'}), 404
        ok = await send_invalidation_notification(_bot, team['team_channel'],
                                                    team['role_id'], submission_type, reason)
        if ok:
            return jsonify({'success': True})
        return jsonify({'error': 'Failed to send notification'}), 500
    except Exception as e:
        logger.error(f'Notify invalidation error: {e}')
        return _db_error(e)
