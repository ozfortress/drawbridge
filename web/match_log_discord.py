"""Discord UI for submitting logs.tf links in match channels."""

import logging
import datetime
import discord
from discord.ui import View, Button, Modal, TextInput
from typing import Optional, Dict, Any

logger = logging.getLogger('drawbridge.match_log_discord')


def _resolve_steam_id3(team_players: list) -> set:
    """Extract steam_id3 values from a Citadel team roster."""
    return {f"[{p['steam_id3']}]" for p in team_players if p.get('steam_id3')}


def _field(obj, key: str, default=None):
    """Read ``key`` from a dict or a Citadel object (which has no ``.get``)."""
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _verify_log(match: Dict[str, Any], log_data: Dict[str, Any],
                team_home, team_away) -> Dict[str, Any]:
    """Verify a log against a match. Returns verification details."""
    home_players = _resolve_steam_id3(_field(team_home, 'players') or [])
    away_players = _resolve_steam_id3(_field(team_away, 'players') or [])
    log_players = log_data.get('players', {})

    red_players = {p for p in log_players if log_players[p].get('team') == 'Red'}
    blue_players = {p for p in log_players if log_players[p].get('team') == 'Blue'}

    home_in_red = home_players & red_players
    home_in_blue = home_players & blue_players
    away_in_red = away_players & red_players
    away_in_blue = away_players & blue_players

    home_found = len(home_in_red) + len(home_in_blue)
    away_found = len(away_in_red) + len(away_in_blue)
    home_total = len(home_players)
    away_total = len(away_players)

    if home_found >= away_found and home_found > 0:
        home_team_red = len(home_in_red) >= len(home_in_blue)
    elif away_found > 0:
        # Infer from the away team's side: away on BLU means home was RED.
        home_team_red = len(away_in_blue) >= len(away_in_red)
    else:
        home_team_red = None

    red_team_id = match['team_home'] if home_team_red else (match['team_away'] if home_team_red is False else None)
    blu_team_id = match['team_away'] if home_team_red else (match['team_home'] if home_team_red is False else None)

    played_at = datetime.datetime.fromtimestamp(log_data['info']['date'])
    now = datetime.datetime.now()
    time_diff = abs((now - played_at).total_seconds()) / 60

    map_name = log_data.get('info', {}).get('map', 'unknown')

    return {
        'map_name': map_name,
        'red_score': log_data['teams']['Red']['score'],
        'blu_score': log_data['teams']['Blue']['score'],
        'played_at': played_at,
        'home_overlap': home_found,
        'home_roster_size': home_total,
        'away_overlap': away_found,
        'away_roster_size': away_total,
        'red_team_id': red_team_id,
        'blu_team_id': blu_team_id,
        'time_diff_minutes': int(time_diff),
    }


def _format_result_embed(result: Dict[str, Any], match: Dict[str, Any],
                         team_home_name: str, team_away_name: str) -> discord.Embed:
    """Build a Discord embed summarising the log verification."""
    home_pct = (result['home_overlap'] / max(result['home_roster_size'], 1)) * 100
    away_pct = (result['away_overlap'] / max(result['away_roster_size'], 1)) * 100
    overall_pct = (
        (result['home_overlap'] + result['away_overlap'])
        / max(result['home_roster_size'] + result['away_roster_size'], 1)
    ) * 100

    red_name = team_home_name if result['red_team_id'] == match['team_home'] else team_away_name
    blu_name = team_away_name if result['red_team_id'] == match['team_home'] else team_home_name

    embed = discord.Embed(
        title=f"📋 Match Log — {result['map_name']}",
        url=f"https://logs.tf/{result.get('_log_id', '')}",
        timestamp=result['played_at'],
    )
    embed.add_field(name="Score", value=f"🟥 {red_name} **{result['red_score']}** – **{result['blu_score']}** {blu_name} 🟦", inline=False)
    embed.add_field(name="Home Team", value=f"{team_home_name} — {result['home_overlap']}/{result['home_roster_size']} players ({home_pct:.0f}%)", inline=True)
    embed.add_field(name="Away Team", value=f"{team_away_name} — {result['away_overlap']}/{result['away_roster_size']} players ({away_pct:.0f}%)", inline=True)
    embed.add_field(name="Overall Overlap", value=f"{overall_pct:.0f}%", inline=True)
    embed.set_footer(text=f"Played ~{result['time_diff_minutes']}m from scheduled time")
    return embed


class MatchLogSubmitModal(Modal, title='Submit Match Log'):
    """Modal for captains to submit a logs.tf URL."""

    log_url = TextInput(
        label='Logs.tf URL',
        placeholder='https://logs.tf/123456',
        required=True,
        max_length=255,
    )

    def __init__(self, match_id: int):
        super().__init__()
        self.match_id = match_id

    async def on_submit(self, interaction: discord.Interaction):
        from web.admin_panel import _db, _cit

        raw = self.log_url.value.strip()
        parts = raw.split('logs.tf/')
        if len(parts) < 2:
            await interaction.response.send_message('Invalid logs.tf URL.', ephemeral=True)
            return
        log_id_str = parts[-1].split('/')[0].split('#')[0].split(' ')[0]
        if not log_id_str.isdigit():
            await interaction.response.send_message('Could not extract a numeric log ID from that URL.', ephemeral=True)
            return
        log_id = int(log_id_str)

        match = _db.matches.get_by_id(self.match_id)
        if not match:
            await interaction.response.send_message('Match not found in database.', ephemeral=True)
            return

        existing_logs = _db.match_logs.get_by_match(self.match_id)
        for el in existing_logs:
            if el['log_id'] == log_id_str:
                await interaction.response.send_message(f'A log (ID {log_id_str}) has already been submitted for this match.', ephemeral=True)
                return

        await interaction.response.defer(ephemeral=False)

        try:
            log_data = await _fetch_log_data_async(log_id)
        except Exception as e:
            logger.warning(f'Failed to fetch log {log_id}: {e}')
            await interaction.followup.send(f'Failed to fetch log from logs.tf: {e}', ephemeral=True)
            return

        if not log_data:
            await interaction.followup.send('Could not fetch log data from logs.tf.', ephemeral=True)
            return

        map_name = log_data.get('info', {}).get('map', '')
        for el in existing_logs:
            if el['map_name'] == map_name:
                await interaction.followup.send(f'A log for map **{map_name}** has already been submitted.', ephemeral=True)
                return

        try:
            team_home = _cit.getTeam(match['team_home'])
            team_away = _cit.getTeam(match['team_away'])
        except Exception as e:
            logger.warning(f'Failed to fetch team data for match {self.match_id}: {e}')
            await interaction.followup.send('Failed to fetch team roster data.', ephemeral=True)
            return

        if not team_home or not team_away:
            await interaction.followup.send('Could not retrieve team rosters.', ephemeral=True)
            return

        result = _verify_log(match, log_data, team_home, team_away)
        result['_log_id'] = log_id_str

        db_entry = {
            'match_id': self.match_id,
            'log_id': log_id_str,
            'map_name': result['map_name'],
            'submitted_by': interaction.user.id,
            'red_team_id': result['red_team_id'],
            'blu_team_id': result['blu_team_id'],
            'red_score': result['red_score'],
            'blu_score': result['blu_score'],
            'played_at': result['played_at'],
            'home_overlap': result['home_overlap'],
            'home_roster_size': result['home_roster_size'],
            'away_overlap': result['away_overlap'],
            'away_roster_size': result['away_roster_size'],
        }
        _db.match_logs.insert(db_entry)

        team_home_name = _field(team_home, 'name') or f"Team {match['team_home']}"
        team_away_name = _field(team_away, 'name') or f"Team {match['team_away']}"
        embed = _format_result_embed(result, match, team_home_name, team_away_name)
        await interaction.followup.send(embed=embed)


async def _fetch_log_data_async(log_id: int) -> Optional[Dict[str, Any]]:
    """Fetch log data from logs.tf API using aiohttp."""
    import aiohttp
    url = f'https://logs.tf/api/v1/log/{log_id}'
    async with aiohttp.ClientSession() as session:
        async with session.get(url) as resp:
            if resp.status != 200:
                return None
            data = await resp.json()
            if not data.get('success'):
                return None
            return data


class MatchLogSubmitView(View):
    """Persistent '📋 Submit Match Log' button pinned in each match channel."""

    def __init__(self, match_id: int):
        super().__init__(timeout=None)
        self.match_id = match_id
        btn = Button(label='📋 Submit Match Log', style=discord.ButtonStyle.secondary,
                     custom_id=f'match_log_submit_{match_id}')
        btn.callback = self._callback
        self.add_item(btn)

    async def _callback(self, interaction: discord.Interaction):
        modal = MatchLogSubmitModal(self.match_id)
        await interaction.response.send_modal(modal)


def register_match_log_views(bot, db):
    """Re-register persistent log submission views for all matches."""
    if not db:
        return
    for match in db.matches.get_all():
        if match.get('channel_id') and match['channel_id'] != 0:
            bot.add_view(MatchLogSubmitView(match['match_id']))
