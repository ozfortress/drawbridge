"""Background task that monitors tracked channels and recreates deleted ones."""

import logging
import os
import discord
from discord.ext import tasks as discord_tasks
from modules.logging_config import get_logger

logger = get_logger('drawbridge.channel_monitor')

_initialized = False
_monitor_task = None

ROLE_STYLES = {
    'player_home': 0x3498db,   # blue
    'player_away': 0xe74c3c,   # red
    'director':    0x8e44ad,   # dark purple
    'head_admin':  0xe67e22,   # orange-red
    'admin':       0xf1c40f,   # yellow
    'staff':       0x1abc9c,   # teal
    'caster':      0x9b59b6,   # purple
    'unknown':     0x7f8c8d,   # grey
}

_ROLE_ID_CACHE = {}


def _get_role_set(*keywords):
    """Get a set of role IDs matching the given keywords (cached)."""
    key = frozenset(keywords)
    if key not in _ROLE_ID_CACHE:
        _ROLE_ID_CACHE[key] = set(_get_role_ids(*keywords))
    return _ROLE_ID_CACHE[key]


def _resolve_member_role(member, home_role_id, away_role_id):
    """Determine a member's highest-priority role category.
    Priority: home team > away team > director > head_admin > admin > staff > caster.
    Returns (key, label) where key is one of the ROLE_STYLES keys.
    """
    if not member:
        return ('unknown', 'Unknown')
    role_ids = {r.id for r in member.roles}

    if home_role_id and home_role_id in role_ids:
        return ('player_home', 'Home team')
    if away_role_id and away_role_id in role_ids:
        return ('player_away', 'Away team')

    if role_ids & _get_role_set('DIRECTOR'):
        return ('director', 'Director')
    if role_ids & _get_role_set('HEAD'):
        return ('head_admin', 'Head Admin')
    if role_ids & _get_role_set('ADMIN', 'TRIAL', '!HEAD'):
        return ('admin', 'Admin')
    if role_ids & _get_role_set('DEVELOPER', 'APPROVED', 'STAFF', '!UNAPPROVED'):
        return ('staff', 'Staff')
    if role_ids & _get_role_set('CASTER'):
        return ('caster', 'Caster')

    return ('unknown', 'Unknown')


async def rebuild_match_channel(bot, db, match, tracked):
    """Rebuild a deleted match channel. Returns the new channel."""
    guild = bot.get_guild(int(os.getenv('DISCORD_GUILD_ID')))
    if not guild:
        raise RuntimeError('Discord guild not found')

    team_home = db.teams.get_by_team_id(match['team_home'])
    team_away = db.teams.get_by_team_id(match['team_away'])
    if not team_home:
        raise RuntimeError(f'Home team {match["team_home"]} not found in database')
    if not team_away:
        raise RuntimeError(f'Away team {match["team_away"]} not found in database')

    divs = db.divisions.get_by_league(match['league_id'])
    category_id = None
    for d in divs:
        if d['id'] == match.get('division') or d['division_name'] == str(match.get('division')):
            category_id = d['category_id']
            break
    if not category_id and divs:
        category_id = divs[0]['category_id']

    cat = guild.get_channel(category_id)
    if not cat:
        raise RuntimeError(f'Division category channel {category_id} not found in guild')

    role_home = guild.get_role(team_home['role_id'])
    role_away = guild.get_role(team_away['role_id'])
    if not role_home:
        raise RuntimeError(f'Home team role {team_home["role_id"]} not found in guild')
    if not role_away:
        raise RuntimeError(f'Away team role {team_away["role_id"]} not found in guild')

    # Deactivate ALL old tracked entries for this match so the monitor
    # doesn't rebuild again from stale entries left by prior cycles.
    try:
        for old in (db.tracked_channels.get_by_match(match['match_id']) or []):
            if old.get('active'):
                db.tracked_channels.deactivate(old['channel_id'])
    except Exception:
        pass

    overrides = {
        guild.default_role: discord.PermissionOverwrite(view_channel=False, send_messages=False),
        role_home: discord.PermissionOverwrite(view_channel=True, send_messages=True),
        role_away: discord.PermissionOverwrite(view_channel=True, send_messages=True),
    }
    all_access_ids = _get_role_ids('HEAD', 'ADMIN', 'TRIAL', 'DEVELOPER', 'APPROVED', '!UNAPPROVED', 'BOT', 'STAFF')
    for role_id in all_access_ids:
        role = guild.get_role(role_id)
        if role:
            overrides[role] = discord.PermissionOverwrite(view_channel=True, send_messages=True)

    # Build original channel name format
    home_name = team_home.get('team_name', 'Home')
    away_name = team_away.get('team_name', 'Away')
    channel_name = f'🗡️-{match["match_id"]}-{home_name}-vs-{away_name}'
    if len(channel_name) > 100:
        channel_name = f'🗡️{match["match_id"]}-{home_name[:10]}-vs-{away_name[:10]}'

    new_channel = await guild.create_text_channel(channel_name, category=cat, overwrites=overrides)

    db.tracked_channels.upsert_by_channel({
        'channel_id': new_channel.id,
        'channel_type': 'match',
        'match_id': match['match_id'],
        'league_id': match['league_id'],
        'active': 1,
    })
    db.matches.update(match['match_id'], {'channel_id': new_channel.id})

    # Send bot setup messages first
    await new_channel.send(
        '🔄 **Channel Rebuilt** — The original was deleted and has been recreated. '
        'Message history is replayed below as embeds.'
    )

    # Match intro embed from template (same as original channel creation)
    try:
        from web.template_helper import get_template
        raw = get_template('match.json')
        if raw:
            import json
            content = raw
            for k, v in {
                '{TEAM_HOME}': f'<@&{team_home["role_id"]}>',
                '{TEAM_AWAY}': f'<@&{team_away["role_id"]}>',
                '{ROUND_NAME}': f'Match {match["match_id"]}',
                '{MATCH_ID}': match['match_id'],
                '{CHANNEL_ID}': str(new_channel.id),
                '{CHANNEL_LINK}': f'<#{new_channel.id}>',
            }.items():
                content = content.replace(k, str(v))
            msg_data = json.loads(content)
            msg_data['embed'] = discord.Embed(**msg_data['embeds'][0])
            del msg_data['embeds']
            notice_msg = await new_channel.send(**msg_data)
            try:
                await notice_msg.pin()
            except Exception:
                pass
    except Exception as e:
        logger.warning(f'Failed to send match intro template: {e}')

    # Log submission button
    try:
        from web.match_log_discord import MatchLogSubmitView
        await new_channel.send('Submit your match logs below once the match is complete.',
                               view=MatchLogSubmitView(match['match_id']))
    except Exception as e:
        logger.warning(f'Failed to send log submission view: {e}')

    # Scheduling button (if enabled for this league)
    try:
        settings = db.tournament_schedule_settings.get_by_league(match['league_id'])
        if settings and settings.get('scheduling_enabled'):
            from web.match_schedule_discord import post_schedule_message
            await post_schedule_message(bot, db, {
                'match_id': match['match_id'],
                'channel_id': new_channel.id,
                'league_id': match['league_id'],
            }, settings)
    except Exception as e:
        logger.warning(f'Failed to send schedule message: {e}')

    # Replay message history as embeds (chat + scheduling events)
    _role_cache = {}
    home_role_id = team_home['role_id']
    away_role_id = team_away['role_id']

    logs = db.logs.get_by_match_id(match['match_id'])
    for log_entry in logs:
        if log_entry['log_type'] not in ('CREATE', 'SCHED'):
            continue
        uid = log_entry.get('user_id')
        if uid not in _role_cache:
            member = guild.get_member(int(uid)) if uid else None
            _role_cache[uid] = _resolve_member_role(member, home_role_id, away_role_id)
        role_key, role_label = _role_cache[uid]
        if role_key == 'player_home':
            role_label = f'Home team: {home_name}'
        elif role_key == 'player_away':
            role_label = f'Away team: {away_name}'
        color_val = ROLE_STYLES.get(role_key, 0x7f8c8d)
        embed = discord.Embed(
            description=log_entry['message_content'][:2000] if log_entry['message_content'] else '*no text*',
            timestamp=log_entry['log_timestamp'] if hasattr(log_entry['log_timestamp'], 'timestamp') else None,
            color=discord.Color(color_val),
        )
        embed.set_author(
            name=log_entry['user_nick'] or log_entry['user_name'],
            icon_url=log_entry['user_avatar'],
        )
        footer_parts = [role_label]
        if log_entry['message_additionals']:
            embed.add_field(name='Attachments', value=log_entry['message_additionals'][:500], inline=False)
            footer_parts.append('📎')
        if log_entry['log_type'] == 'SCHED':
            footer_parts.append('📅')
        embed.set_footer(text=' | '.join(footer_parts))
        try:
            await new_channel.send(embed=embed)
        except Exception:
            continue

    logger.info(f'Rebuilt match channel for match {match["match_id"]} (new channel: {new_channel.id})')
    return new_channel


async def rebuild_team_channel(bot, db, team, tracked):
    """Rebuild a deleted team channel."""
    guild = bot.get_guild(int(os.getenv('DISCORD_GUILD_ID')))
    if not guild:
        raise RuntimeError('Discord guild not found')

    role = guild.get_role(team['role_id'])
    if not role:
        raise RuntimeError(f'Team role {team["role_id"]} not found in guild')

    divs = db.divisions.get_by_league(team['league_id'])
    category_id = None
    for d in divs:
        if d['id'] == team.get('division'):
            category_id = d['category_id']
            break
    if not category_id and divs:
        category_id = divs[0]['category_id']
    if not category_id:
        raise RuntimeError(f'Division category not found for team division={team.get("division")}')
    cat = guild.get_channel(category_id)
    if not cat:
        raise RuntimeError(f'Division category channel {category_id} not found in guild')

    # Deactivate the old tracked entry so the monitor doesn't rebuild again
    if tracked and tracked.get('channel_id'):
        try:
            db.tracked_channels.deactivate(tracked['channel_id'])
        except Exception:
            pass

    overrides = {
        guild.default_role: discord.PermissionOverwrite(view_channel=False, send_messages=False),
        role: discord.PermissionOverwrite(view_channel=True, send_messages=True),
    }
    all_access_ids = _get_role_ids('HEAD', 'ADMIN', 'TRIAL', 'DEVELOPER', 'APPROVED', '!UNAPPROVED', 'BOT', 'STAFF')
    for role_id in all_access_ids:
        r = guild.get_role(role_id)
        if r:
            overrides[r] = discord.PermissionOverwrite(view_channel=True, send_messages=True)

    new_channel = await guild.create_text_channel(
        f'🛡️{team["team_name"]}', category=cat, overwrites=overrides
    )

    db.tracked_channels.upsert_by_channel({
        'channel_id': new_channel.id,
        'channel_type': 'team',
        'team_id': team['team_id'],
        'league_id': team['league_id'],
        'active': 1,
    })
    db.teams.update(team['roster_id'], {'team_channel': new_channel.id})

    await new_channel.send(
        '🔄 **Team channel automatically rebuilt.** The original was deleted. '
        'All functions have been restored.'
    )

    logger.info(f'Rebuilt team channel for team {team["team_id"]} (new channel: {new_channel.id})')
    return new_channel


def _get_role_ids(*keywords):
    """Replicate check._get_role_ids without needing the Checks instance."""
    roles = {key.upper(): value for key, value in os.environ.items() if key.upper().startswith('ROLE_')}
    pos = []
    anti = []
    for w in keywords:
        (anti if w.startswith('!') else pos).append(w[1:].upper() if w.startswith('!') else w.upper())
    return [
        int(v) for k, v in roles.items()
        if any(p in k for p in pos) and not any(a in k for a in anti)
    ]


def start_channel_monitor(bot, db):
    """Start the background channel monitoring loop."""
    global _initialized, _monitor_task

    if _initialized:
        return

    @discord_tasks.loop(minutes=15)
    async def monitor_loop():
        if not bot.is_ready():
            return
        guild = bot.get_guild(int(os.getenv('DISCORD_GUILD_ID')))
        if not guild:
            return

        tracked_list = db.tracked_channels.get_active()
        rebuilt_matches = set()
        rebuilt_teams = set()
        for tracked in tracked_list:
            channel = guild.get_channel(tracked['channel_id'])
            if channel is not None:
                continue

            try:
                channel = await guild.fetch_channel(tracked['channel_id'])
            except Exception:
                channel = None

            if channel is not None:
                continue

            # Skip if already rebuilt in this cycle (stale duplicate entry)
            if tracked['channel_type'] == 'match' and tracked.get('match_id') in rebuilt_matches:
                continue
            if tracked['channel_type'] == 'team' and tracked.get('team_id') in rebuilt_teams:
                continue

            logger.warning(
                f'Tracked {tracked["channel_type"]} channel {tracked["channel_id"]} '
                f'is missing — auto-rebuilding.'
            )

            try:
                if tracked['channel_type'] == 'match':
                    match = db.matches.get_by_id(tracked['match_id'])
                    if match and not match.get('archived'):
                        await rebuild_match_channel(bot, db, match, tracked)
                        rebuilt_matches.add(tracked['match_id'])
                elif tracked['channel_type'] == 'team':
                    team = db.teams.get_by_id(tracked['team_id'])
                    if team:
                        await rebuild_team_channel(bot, db, team, tracked)
                        rebuilt_teams.add(tracked['team_id'])
            except Exception:
                logger.exception(f'Error rebuilding {tracked["channel_type"]} channel {tracked["channel_id"]}')

    _initialized = True
    _monitor_task = monitor_loop
    monitor_loop.start()
    logger.info('Channel monitor started (15-minute interval)')
