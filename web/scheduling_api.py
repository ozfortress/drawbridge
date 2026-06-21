"""Internal HTTP API for match scheduling, for consumption by an external website.

Server-to-server: authenticated with a static key (``INTERNAL_API_KEY``) sent as
either ``X-API-Key: <key>`` or ``Authorization: Bearer <key>``. Returns JSON.

Read endpoints expose league settings, per-match schedules, team availability and
overdue matches. A single write endpoint lets a trusted caller set/override a
match's confirmed time (and, if the bot is up, mirror it into Discord).

Registered as a blueprint in ``simple_web_server.py``. Shares the bot/db globals
that ``admin_panel.initialize`` populates on bot startup.
"""

import os
import functools
import datetime

from quart import Blueprint, request, jsonify

from modules.logging_config import get_logger

logger = get_logger('drawbridge.web.scheduling_api', 'web.log')

scheduling_api_bp = Blueprint('scheduling_api', __name__, url_prefix='/api/scheduling')

DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']


# ── Auth ─────────────────────────────────────────────────────

def require_api_key(f):
    @functools.wraps(f)
    async def wrapper(*args, **kwargs):
        expected = os.getenv('INTERNAL_API_KEY')
        if not expected:
            return jsonify({'error': 'Internal API not configured (INTERNAL_API_KEY unset)'}), 503
        provided = request.headers.get('X-API-Key', '')
        if not provided:
            auth = request.headers.get('Authorization', '')
            if auth.startswith('Bearer '):
                provided = auth[7:]
        if provided != expected:
            return jsonify({'error': 'Unauthorized'}), 401
        return await f(*args, **kwargs)
    return wrapper


# ── Shared bot/db (populated by admin_panel.initialize on startup) ──

def _get_db():
    from web.admin_panel import _db
    return _db


def _get_bot():
    from web.admin_panel import _bot
    return _bot


def _get_tournament_cog():
    from web.admin_panel import _tournament_cog
    return _tournament_cog


# ── Serialization ────────────────────────────────────────────

def _iso(dt):
    if dt is None:
        return None
    if isinstance(dt, datetime.datetime):
        return dt.replace(tzinfo=datetime.timezone.utc).isoformat()
    return str(dt)


def _unix(dt):
    if isinstance(dt, datetime.datetime):
        return int(dt.replace(tzinfo=datetime.timezone.utc).timestamp())
    return None


def _serialize(db, s: dict) -> dict:
    """Turn a match_schedules row into a JSON-friendly dict, resolving teams."""
    match_id = s['match_id']
    match = db.matches.get_by_id(match_id)
    home = away = None
    channel_id = None
    division = None
    if match:
        channel_id = match.get('channel_id')
        division = match.get('division')
        if match.get('team_home'):
            home = db.teams.get_by_team_and_league(match['team_home'], s['league_id'])
        if match.get('team_away'):
            away = db.teams.get_by_team_and_league(match['team_away'], s['league_id'])
    proposed = None
    if s.get('status') == 'proposed':
        day = s.get('proposed_day')
        proposed = {
            'day': day,
            'day_name': DAY_NAMES[day] if day is not None else None,
            'time': s.get('proposed_time'),
            'by_team': s.get('proposed_by_team'),
            'by_user': str(s['proposed_by_user']) if s.get('proposed_by_user') else None,
            'at': _iso(s.get('proposed_at')),
        }
    return {
        'match_id': match_id,
        'league_id': s['league_id'],
        'division_id': division,
        'status': s.get('status'),
        'home_team': {
            'team_id': match.get('team_home') if match else None,
            'name': home.get('team_name') if home else None,
        },
        'away_team': {
            'team_id': match.get('team_away') if match else None,
            'name': away.get('team_name') if away else None,
        },
        'proposed': proposed,
        'scheduled_at': _iso(s.get('scheduled_at')),
        'scheduled_at_unix': _unix(s.get('scheduled_at')),
        'deadline_at': _iso(s.get('deadline_at')),
        'deadline_at_unix': _unix(s.get('deadline_at')),
        'deadline_flagged': bool(s.get('deadline_flagged')),
        'channel_id': str(channel_id) if channel_id else None,
        'match_url': f'https://ozfortress.com/matches/{match_id}',
    }


# ── Read endpoints ───────────────────────────────────────────

@scheduling_api_bp.route('/health')
@require_api_key
async def health():
    return jsonify({'ok': True, 'db': bool(_get_db()), 'bot': bool(_get_bot())})


@scheduling_api_bp.route('/leagues/<int:league_id>/settings')
@require_api_key
async def league_settings(league_id: int):
    db = _get_db()
    if not db:
        return jsonify({'error': 'Database not ready'}), 503
    s = db.tournament_schedule_settings.get_by_league(league_id)
    if not s:
        return jsonify({'settings': None})
    excluded = [int(x) for x in str(s['excluded_days']).split(',') if str(x).strip()] if s.get('excluded_days') else []
    return jsonify({'settings': {
        'league_id': league_id,
        'scheduling_enabled': bool(s.get('scheduling_enabled')),
        'format': s.get('format'),
        'excluded_days': excluded,
        'deadline_day': s.get('deadline_day'),
        'deadline_time': s.get('deadline_time'),
    }})


@scheduling_api_bp.route('/leagues/<int:league_id>/matches')
@require_api_key
async def league_matches(league_id: int):
    db = _get_db()
    if not db:
        return jsonify({'error': 'Database not ready'}), 503
    rows = db.match_schedules.get_by_league(league_id)
    return jsonify({'matches': [_serialize(db, r) for r in rows]})


@scheduling_api_bp.route('/matches/<int:match_id>')
@require_api_key
async def match_detail(match_id: int):
    db = _get_db()
    if not db:
        return jsonify({'error': 'Database not ready'}), 503
    s = db.match_schedules.get_by_match_id(match_id)
    if not s:
        return jsonify({'error': 'No schedule for this match'}), 404
    return jsonify({'match': _serialize(db, s)})


@scheduling_api_bp.route('/leagues/<int:league_id>/availability')
@require_api_key
async def league_availability(league_id: int):
    """Team availability set at registration, grouped by team then day."""
    db = _get_db()
    if not db:
        return jsonify({'error': 'Database not ready'}), 503
    rows = db.team_availability.get_by_league(league_id)
    teams: dict[int, dict] = {}
    for r in rows:
        t = teams.setdefault(r['team_id'], {})
        t.setdefault(r['day_of_week'], []).append(r['time_slot'])
    out = []
    for team_id, days in teams.items():
        team = db.teams.get_by_team_and_league(team_id, league_id)
        out.append({
            'team_id': team_id,
            'name': team.get('team_name') if team else None,
            'availability': [
                {'day': d, 'day_name': DAY_NAMES[d], 'times': sorted(days[d])}
                for d in sorted(days)
            ],
        })
    return jsonify({'teams': out})


@scheduling_api_bp.route('/overdue')
@require_api_key
async def overdue():
    """All unconfirmed matches past their deadline (across leagues)."""
    db = _get_db()
    if not db:
        return jsonify({'error': 'Database not ready'}), 503
    rows = db.match_schedules.get_overdue(datetime.datetime.utcnow())
    return jsonify({'matches': [_serialize(db, r) for r in rows]})


# ── Write endpoint: set/override a match's confirmed time ─────

@scheduling_api_bp.route('/matches/<int:match_id>/set', methods=['POST'])
@require_api_key
async def set_match_time(match_id: int):
    """Set (or override) a match's scheduled time.

    Body JSON: ``{"day": 0..6, "time": "HH:MM", "notify": true}``.
    Creates the schedule row if one doesn't exist (e.g. scheduling disabled for
    the league but an admin wants to set a time anyway).
    """
    db = _get_db()
    if not db:
        return jsonify({'error': 'Database not ready'}), 503
    data = await request.get_json() or {}
    try:
        day = int(data['day'])
        time_str = str(data['time'])
        if not (0 <= day <= 6) or ':' not in time_str:
            raise ValueError
    except (KeyError, ValueError, TypeError):
        return jsonify({'error': 'Body must include day (0=Mon..6=Sun) and time (HH:MM)'}), 400

    match = db.matches.get_by_id(match_id)
    if not match:
        return jsonify({'error': 'Match not found — generate it first'}), 404

    from web.match_schedule_discord import next_occurrence
    scheduled = next_occurrence(day, time_str)
    if not db.match_schedules.get_by_match_id(match_id):
        db.match_schedules.insert({'match_id': match_id, 'league_id': match['league_id']})
    db.match_schedules.set_confirmed(match_id, scheduled.replace(tzinfo=None))

    notified = False
    if data.get('notify', True):
        notified = await _notify_channel(db, match, scheduled)

    s = db.match_schedules.get_by_match_id(match_id)
    return jsonify({'success': True, 'notified': notified, 'match': _serialize(db, s)})


async def _notify_channel(db, match, scheduled_aware) -> bool:
    """Post a confirmation in the match channel and refresh the launchpad."""
    bot = _get_bot()
    if not bot or not match.get('channel_id'):
        return False
    try:
        import discord
        channel = bot.get_channel(match['channel_id'])
        if channel is None:
            return False
        unix = int(scheduled_aware.timestamp())
        embed = discord.Embed(
            title='✅ Match Scheduled',
            description=f'An admin set this match for <t:{unix}:F> (<t:{unix}:R>).',
            color=discord.Color.green(),
        )
        await channel.send(embed=embed)
        cog = _get_tournament_cog()
        if cog:
            await cog.update_launchpad()
        return True
    except Exception as e:
        logger.error(f'Failed to notify channel for match {match.get("match_id")}: {e}')
        return False
