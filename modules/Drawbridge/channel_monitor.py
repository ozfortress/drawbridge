"""Background task that monitors tracked channels and recreates deleted ones."""

import logging
import os
import discord
from discord.ext import tasks as discord_tasks
from modules.logging_config import get_logger

logger = get_logger('drawbridge.channel_monitor')

_initialized = False
_monitor_task = None


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

    # Post rebuilt notice first
    await new_channel.send(
        '🔄 **Channel Rebuilt** — The original was deleted and has been recreated. '
        'Message history is replayed below as embeds.'
    )

    # Replay message history as embeds
    logs = db.logs.get_by_match_id(match['match_id'])
    for log_entry in logs:
        if log_entry['log_type'] != 'CREATE':
            continue
        color_map = {
            'admin': discord.Color.red(),
            'staff': discord.Color.orange(),
            'caster': discord.Color.purple(),
            'player_home': discord.Color.blue(),
            'player_away': discord.Color.green(),
        }
        color = color_map.get(log_entry.get('role_type', ''), discord.Color.dark_grey())
        embed = discord.Embed(
            description=log_entry['message_content'][:2000] if log_entry['message_content'] else '*no text*',
            timestamp=log_entry['log_timestamp'] if hasattr(log_entry['log_timestamp'], 'timestamp') else None,
            color=color,
        )
        embed.set_author(
            name=log_entry['user_nick'] or log_entry['user_name'],
            icon_url=log_entry['user_avatar'],
        )
        footer_parts = [log_entry.get('role_type', 'player')]
        if log_entry['message_additionals']:
            embed.add_field(name='Attachments', value=log_entry['message_additionals'][:500], inline=False)
            footer_parts.append('📎')
        embed.set_footer(text=' | '.join(footer_parts))
        try:
            await new_channel.send(embed=embed)
        except Exception:
            continue

    # Send match intro embed from template (same as original channel creation)
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

            logger.warning(
                f'Tracked {tracked["channel_type"]} channel {tracked["channel_id"]} '
                f'is missing — auto-rebuilding.'
            )

            try:
                if tracked['channel_type'] == 'match':
                    match = db.matches.get_by_id(tracked['match_id'])
                    if match and not match.get('archived'):
                        await rebuild_match_channel(bot, db, match, tracked)
                elif tracked['channel_type'] == 'team':
                    team = db.teams.get_by_id(tracked['team_id'])
                    if team:
                        await rebuild_team_channel(bot, db, team, tracked)
            except Exception:
                logger.exception(f'Error rebuilding {tracked["channel_type"]} channel {tracked["channel_id"]}')

    _initialized = True
    _monitor_task = monitor_loop
    monitor_loop.start()
    logger.info('Channel monitor started (15-minute interval)')
