"""Side-effect-free planning for tournament creation.

Builds the exact set of Discord categories, roles and channels that the admin
panel's "Start Tournament" flow will create, plus the captain role assignments
that follow it. Nothing in here mutates Discord or the database, so the same
plan can be shown to admins as a preview before they commit.

The names, trimming and permission sets intentionally mirror
``web.admin_panel.api_tournament_start`` so that a preview always matches what
creation would actually do.
"""

from __future__ import annotations

import datetime
import re
from typing import Optional

import discord

from modules.Drawbridge.checks import Checks

checks = Checks()

# Permission sets used when creating division categories / team channels.
CATEGORY_ACCESS = ('HEAD', 'ADMIN', '!AC', 'TRIAL', 'DEVELOPER', 'APPROVED', '!UNAPPROVED', 'BOT')
TEAM_ACCESS = ('HEAD', 'ADMIN', 'TRIAL', 'DEVELOPER', 'BOT')

# Discord name limits.
MAX_TEAM_NAME = 50
MAX_ROLE_NAME = 20
MAX_CHANNEL_NAME = 20
DISCORD_NAME_LIMIT = 100


def _field(obj, key, default=None):
    """Read ``key`` from either a dict or a Citadel-style object."""
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _role_ref(role: Optional[discord.Role]) -> Optional[dict]:
    if role is None:
        return None
    return {'id': role.id, 'name': role.name}


def parse_role_overrides(guild: discord.Guild, role_overrides: Optional[str]):
    """Resolve role overrides to ``(roles, missing)``.

    Accepts comma-separated role mentions, role IDs and role names, matching the
    parser used by the creation flow.
    """
    if not role_overrides:
        return [], []
    roles: list[discord.Role] = []
    missing: list[str] = []

    def add(role: Optional[discord.Role], entry: str):
        if role is None:
            missing.append(entry)
        elif role not in roles:
            roles.append(role)

    # Picking roles from Discord's mention list sends <@&id>, often space-separated.
    for role_id in re.findall(r'<@&(\d+)>', role_overrides):
        add(guild.get_role(int(role_id)), f'<@&{role_id}>')
    for entry in re.sub(r'<@&\d+>', ',', role_overrides).split(','):
        name = entry.strip()
        if not name:
            continue
        role = guild.get_role(int(name)) if name.isdigit() else None
        role = role or discord.utils.get(guild.roles, name=name) or discord.utils.get(guild.roles, name=name.lstrip('@').strip())
        add(role, name)
    return roles, missing


def _access_roles(guild: discord.Guild, keywords: tuple[str, ...]) -> list[discord.Role]:
    """Resolve role keywords to existing guild roles (missing roles are skipped)."""
    result: list[discord.Role] = []
    seen: set[int] = set()
    for role_id in checks._get_role_ids(*keywords):
        role = guild.get_role(role_id)
        if role is not None and role.id not in seen:
            seen.add(role.id)
            result.append(role)
    return result


def _team_name(roster) -> str:
    return str(_field(roster, 'name', ''))[:MAX_TEAM_NAME]


def _division_names(rosters) -> list[str]:
    names: list[str] = []
    for roster in rosters:
        division = _field(roster, 'division')
        if division not in names:
            names.append(division)
    return names


def _build_assignments(guild: discord.Guild, cit, divisions: list[dict], missing_roles: list[str]) -> dict:
    """Work out which captains would receive their division/team roles.

    Mirrors ``Tournament._assign_roles``: only captains are considered, and
    capture the reasons a captain could not be assigned.
    """
    players: list[dict] = []
    summary = {'will_assign': 0, 'not_linked': 0, 'not_in_server': 0, 'errors': 0}
    for division in divisions:
        for team in division['teams']:
            try:
                cit_team = cit.getTeam(team['team_id'])
            except Exception:
                summary['errors'] += 1
                continue
            if not cit_team:
                continue
            for user in (_field(cit_team, 'players', []) or []):
                if not _field(user, 'is_captain', False):
                    continue
                discord_id = _field(user, 'discord_id')
                entry = {
                    'player_name': _field(user, 'name', 'Unknown'),
                    'discord_id': discord_id,
                    'division': division['name'],
                    'team_name': team['name'],
                    'roles': [division['role_name'], team['role_name']],
                }
                member = None
                if not discord_id:
                    entry['status'] = 'not_linked'
                else:
                    member = guild.get_member(discord_id)
                    entry['status'] = 'will_assign' if member is not None else 'not_in_server'
                entry['member_display'] = str(member) if member is not None else None
                summary[entry['status']] += 1
                players.append(entry)
    return {'summary': summary, 'players': players, 'missing_roles': missing_roles}


def build_tournament_plan(guild: discord.Guild, cit, league, league_shortcode: str,
                          role_overrides: Optional[str] = None,
                          include_assignments: bool = True,
                          already_started: bool = False) -> dict:
    """Build a JSON-serialisable plan for creating a tournament.

    Parameters
    ----------
    guild:
        The Discord guild the tournament would be created in.
    cit:
        Citadel client, used to resolve captain assignments.
    league:
        Citadel league object (must expose ``name`` and ``rosters``).
    league_shortcode:
        Shortcode appended to created role/channel names.
    role_overrides:
        Optional raw role-overrides string.
    include_assignments:
        When True, query Citadel teams for the captains that would be assigned.
    already_started:
        Whether divisions already exist for this league in the database.
    """
    rosters = list(_field(league, 'rosters', []) or [])
    div_names = _division_names(rosters)

    extra_roles, missing_overrides = parse_role_overrides(guild, role_overrides)
    category_access = _access_roles(guild, CATEGORY_ACCESS)
    team_access = _access_roles(guild, TEAM_ACCESS)

    warnings: list[str] = []
    if missing_overrides:
        warnings.append('These role overrides could not be found: ' + ', '.join(f'`{m}`' for m in missing_overrides))
    if already_started:
        warnings.append('This league already has tournament divisions. Starting again will create duplicate categories, roles and channels.')

    divisions: list[dict] = []
    team_count = 0
    for div in div_names:
        div_role_name = f'{div} - {league_shortcode}'
        teams: list[dict] = []
        for roster in rosters:
            if _field(roster, 'division') != div:
                continue
            name = _team_name(roster)
            role_name = f'{name[:MAX_ROLE_NAME]} ({league_shortcode})'
            channel_name = f'🛡️{name[:MAX_CHANNEL_NAME]} ({league_shortcode})'
            if len(role_name) > DISCORD_NAME_LIMIT:
                warnings.append(f'Role name for "{name}" is {len(role_name)} characters and may be rejected by Discord: `{role_name}`')
            if len(channel_name) > DISCORD_NAME_LIMIT:
                warnings.append(f'Channel name for "{name}" is {len(channel_name)} characters and may be rejected by Discord: `{channel_name}`')
            teams.append({
                'team_id': _field(roster, 'team_id'),
                'roster_id': _field(roster, 'id'),
                'name': name,
                'role_name': role_name,
                'channel_name': channel_name,
                'role_name_length': len(role_name),
                'channel_name_length': len(channel_name),
                'name_trimmed': len(str(_field(roster, 'name', ''))) > MAX_TEAM_NAME,
            })
            team_count += 1
        divisions.append({
            'name': div,
            'category_name': div_role_name,
            'role_name': div_role_name,
            'teams': teams,
        })

    plan = {
        'league_id': _field(league, 'id'),
        'league_name': _field(league, 'name'),
        'league_shortcode': league_shortcode,
        'generated_at': datetime.datetime.utcnow().isoformat() + 'Z',
        'already_started': already_started,
        'summary': {
            'divisions': len(divisions),
            'teams': team_count,
            'categories': len(divisions),
            'roles': len(divisions) + team_count,
            'channels': team_count,
        },
        'role_overrides': {
            'resolved': [_role_ref(r) for r in extra_roles],
            'missing': missing_overrides,
        },
        'category_access': [_role_ref(r) for r in category_access],
        'team_access': [_role_ref(r) for r in team_access],
        'permissions': {
            'everyone_can_view_categories': False,
            'everyone_can_view_teams': False,
            'access_roles_can_send_messages': True,
        },
        'warnings': warnings,
        'divisions': divisions,
    }
    plan['assignments'] = _build_assignments(guild, cit, divisions, []) if include_assignments else None
    return plan
