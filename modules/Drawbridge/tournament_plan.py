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
MATCH_ACCESS = ('HEAD', 'ADMIN', 'TRIAL', 'DEVELOPER', 'APPROVED', '!UNAPPROVED', 'BOT', 'STAFF')

# Selectable role-override presets. Each preset describes which extra roles get
# access to which kinds of channel and with what permissions. This is the single
# source of truth shared by the admin page (for display) and the creation flow
# (for applying permissions).
ROLE_OVERRIDE_PRESETS = {
    'admin': {
        'label': 'Admin',
        'description': 'Team and match channels: view, send and manage messages.',
        'applies_to': ['categories', 'team_channels', 'match_channels'],
        'permissions': {'view_channel': True, 'send_messages': True, 'manage_messages': True},
    },
    'staff': {
        'label': 'Staff',
        'description': 'Team and match channels: view and send messages.',
        'applies_to': ['categories', 'team_channels', 'match_channels'],
        'permissions': {'view_channel': True, 'send_messages': True},
    },
    'viewer': {
        'label': 'Viewer',
        'description': 'Team and match channels: read-only access.',
        'applies_to': ['categories', 'team_channels', 'match_channels'],
        'permissions': {'view_channel': True, 'send_messages': False, 'manage_messages': False, 'read_message_history': True},
    },
    'match_viewer': {
        'label': 'Match Viewer',
        'description': 'Match channels only: read-only, cannot send or manage messages.',
        'applies_to': ['match_channels'],
        'permissions': {'view_channel': True, 'send_messages': False, 'manage_messages': False, 'read_message_history': True},
    },
    'caster': {
        'label': 'Caster',
        'description': 'Match channels only: view and send messages (no manage).',
        'applies_to': ['match_channels'],
        'permissions': {'view_channel': True, 'send_messages': True},
    },
}

_LEGACY_OVERRIDE_PRESET = 'staff'

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


def resolve_role(guild: discord.Guild, entry) -> Optional[discord.Role]:
    """Resolve a single role reference (ID, mention or name) to a guild role."""
    if entry is None:
        return None
    if isinstance(entry, int):
        return guild.get_role(entry)
    text = str(entry).strip()
    if not text:
        return None
    mention = re.fullmatch(r'<@&(\d+)>', text)
    if mention:
        return guild.get_role(int(mention.group(1)))
    if text.isdigit():
        return guild.get_role(int(text))
    return (discord.utils.get(guild.roles, name=text)
            or discord.utils.get(guild.roles, name=text.lstrip('@').strip()))


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


def normalize_role_overrides(guild: discord.Guild, raw):
    """Normalise a role-overrides payload into structured groups.

    Accepts:

    * ``None`` / empty — no overrides;
    * a legacy comma-separated string — treated as a single ``staff`` group;
    * a list (or single dict) of ``{"preset": key, "roles": [id|mention|name]}``.

    Returns ``(groups, missing, legacy)`` where each group is a dict with
    ``preset``, ``label``, ``description``, ``applies_to``, ``permissions`` and
    ``roles`` (a list of ``discord.Role``). ``missing`` lists role references that
    could not be resolved. ``legacy`` is True when a raw string was supplied.
    """
    groups: list[dict] = []
    missing: list[str] = []

    if not raw:
        return groups, missing, False

    def build(preset_key: str, roles: list[discord.Role]) -> Optional[dict]:
        preset = ROLE_OVERRIDE_PRESETS.get(preset_key)
        if not preset or not roles:
            return None
        return {
            'preset': preset_key,
            'label': preset['label'],
            'description': preset['description'],
            'applies_to': list(preset['applies_to']),
            'permissions': dict(preset['permissions']),
            'roles': roles,
        }

    # Legacy raw string (e.g. from the slash commands or older clients).
    if isinstance(raw, str):
        roles, miss = parse_role_overrides(guild, raw)
        missing.extend(miss)
        group = build(_LEGACY_OVERRIDE_PRESET, roles)
        if group:
            groups.append(group)
        return groups, missing, True

    items = raw if isinstance(raw, list) else [raw]
    for item in items:
        if not isinstance(item, dict):
            continue
        preset_key = str(item.get('preset') or _LEGACY_OVERRIDE_PRESET).strip()
        role_entries = item.get('roles') or item.get('role_ids') or []
        if isinstance(role_entries, (str, int)):
            role_entries = [role_entries]
        resolved: list[discord.Role] = []
        for entry in role_entries:
            role = resolve_role(guild, entry)
            if role is None:
                missing.append(str(entry))
            elif role not in resolved:
                resolved.append(role)
        group = build(preset_key, resolved)
        if group:
            groups.append(group)
    return groups, missing, False


def serializable_role_overrides(groups: list[dict]) -> list[dict]:
    """Convert normalized groups to a JSON-safe config for persistence."""
    config = []
    for group in groups:
        config.append({
            'preset': group['preset'],
            'role_ids': [role.id for role in group['roles']],
        })
    return config


def overwrites_for_groups(guild: discord.Guild, groups: list[dict], channel_type: str):
    """Build ``(role, PermissionOverwrite)`` pairs for a channel type.

    ``channel_type`` is one of ``categories``, ``team_channels`` or
    ``match_channels``. Categories only receive visibility; other channel types
    receive the full preset permission set.
    """
    pairs: list[tuple[discord.Role, discord.PermissionOverwrite]] = []
    seen: set[int] = set()
    for group in groups:
        if channel_type not in group.get('applies_to', []):
            continue
        perms = group.get('permissions', {})
        if channel_type == 'categories':
            overwrite = discord.PermissionOverwrite(view_channel=perms.get('view_channel', True))
        else:
            overwrite = discord.PermissionOverwrite(**perms)
        for role in group.get('roles', []):
            if role is None or role.id in seen:
                continue
            seen.add(role.id)
            pairs.append((role, overwrite))
    return pairs


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
        Optional raw role-overrides payload: a legacy string or a list of
        ``{"preset": key, "roles": [...]}`` groups.
    include_assignments:
        When True, query Citadel teams for the captains that would be assigned.
    already_started:
        Whether divisions already exist for this league in the database.
    """
    rosters = list(_field(league, 'rosters', []) or [])
    div_names = _division_names(rosters)

    override_groups, missing_overrides, legacy_overrides = normalize_role_overrides(guild, role_overrides)
    category_access = _access_roles(guild, CATEGORY_ACCESS)
    team_access = _access_roles(guild, TEAM_ACCESS)
    match_access = _access_roles(guild, MATCH_ACCESS)

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
            'groups': [
                {
                    'preset': group['preset'],
                    'label': group['label'],
                    'description': group['description'],
                    'applies_to': group['applies_to'],
                    'permissions': group['permissions'],
                    'roles': [_role_ref(r) for r in group['roles']],
                }
                for group in override_groups
            ],
            'resolved': [_role_ref(r) for group in override_groups for r in group['roles']],
            'missing': missing_overrides,
            'legacy': legacy_overrides,
        },
        'category_access': [_role_ref(r) for r in category_access],
        'team_access': [_role_ref(r) for r in team_access],
        'match_access': [_role_ref(r) for r in match_access],
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
