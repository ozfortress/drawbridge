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

# Role-override permission levels. Each level implies the ones before it
# (manage > send > read), and is chosen per role, per channel kind.
OVERRIDE_LEVELS = {
    'none': {
        'label': 'No access',
        'description': 'Do not grant access.',
        'permissions': None,
    },
    'read': {
        'label': 'Read',
        'description': 'View the channel and read history.',
        'permissions': {
            'view_channel': True, 'read_message_history': True,
            'send_messages': False, 'manage_messages': False,
        },
    },
    'send': {
        'label': 'Send',
        'description': 'Read plus send messages.',
        'permissions': {
            'view_channel': True, 'read_message_history': True,
            'send_messages': True, 'manage_messages': False,
        },
    },
    'manage': {
        'label': 'Manage',
        'description': 'Send plus manage messages.',
        'permissions': {
            'view_channel': True, 'read_message_history': True,
            'send_messages': True, 'manage_messages': True,
        },
    },
}
OVERRIDE_LEVEL_ORDER = ['none', 'read', 'send', 'manage']

# Mapping used to migrate the old preset-based configs to level pairs
# (team level, match level).
_LEGACY_PRESET_LEVELS = {
    'admin': ('manage', 'manage'),
    'staff': ('send', 'send'),
    'viewer': ('read', 'read'),
    'match_viewer': ('none', 'read'),
    'caster': ('none', 'send'),
}

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


def _normalize_level(value, default: str = 'none') -> str:
    level = str(value or default).strip().lower()
    return level if level in OVERRIDE_LEVELS else default


def level_permissions(level: str) -> Optional[dict]:
    """Return the PermissionOverwrite kwargs for a level, or None for no access."""
    preset = OVERRIDE_LEVELS.get(_normalize_level(level))
    return dict(preset['permissions']) if preset and preset['permissions'] else None


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
    """Normalise a role-overrides payload into per-role permission entries.

    Accepts:

    * ``None`` / empty — no overrides;
    * a legacy comma-separated string — roles default to ``send`` on both channel
      kinds (the behaviour of the old string overrides);
    * a list (or single dict) of entries. Two shapes are understood:
      - ``{"role_id"|"role"|"id": ref, "team": level, "match": level}`` (current);
      - ``{"preset": key, "roles"|"role_ids": [ref, ...]}`` (older preset config).

    Returns ``(entries, missing, legacy)`` where each entry is
    ``{"role": discord.Role, "team": level, "match": level}``. Levels are one of
    ``none`` / ``read`` / ``send`` / ``manage``.
    """
    entries: list[dict] = []
    missing: list[str] = []
    seen: set[int] = set()

    if not raw:
        return entries, missing, False

    def add(role: Optional[discord.Role], team: str, match: str):
        if role is None:
            return
        if role.id in seen:
            # Keep the highest permission if a role appears more than once.
            existing = next(e for e in entries if e['role'].id == role.id)
            if OVERRIDE_LEVEL_ORDER.index(_normalize_level(team)) > OVERRIDE_LEVEL_ORDER.index(existing['team']):
                existing['team'] = _normalize_level(team)
            if OVERRIDE_LEVEL_ORDER.index(_normalize_level(match)) > OVERRIDE_LEVEL_ORDER.index(existing['match']):
                existing['match'] = _normalize_level(match)
            return
        seen.add(role.id)
        entries.append({'role': role, 'team': _normalize_level(team), 'match': _normalize_level(match)})

    # Legacy raw string (e.g. from the slash commands or older clients).
    if isinstance(raw, str):
        roles, miss = parse_role_overrides(guild, raw)
        missing.extend(miss)
        for role in roles:
            add(role, 'send', 'send')
        return entries, missing, True

    items = raw if isinstance(raw, list) else [raw]
    for item in items:
        if not isinstance(item, dict):
            continue
        # Old preset shape.
        if item.get('preset'):
            preset_key = str(item.get('preset')).strip()
            team, match = _LEGACY_PRESET_LEVELS.get(preset_key, ('send', 'send'))
            role_entries = item.get('roles') or item.get('role_ids') or []
            if isinstance(role_entries, (str, int)):
                role_entries = [role_entries]
            for ref in role_entries:
                role = resolve_role(guild, ref)
                if role is None:
                    missing.append(str(ref))
                else:
                    add(role, team, match)
            continue
        # Current per-role shape.
        ref = item.get('role_id', item.get('role', item.get('id')))
        role = resolve_role(guild, ref)
        if role is None:
            if ref is not None:
                missing.append(str(ref))
            continue
        add(role, item.get('team', 'none'), item.get('match', 'none'))
    return entries, missing, False


def serializable_role_overrides(entries: list[dict]) -> list[dict]:
    """Convert normalized entries to a JSON-safe config for persistence."""
    return [
        {'role_id': entry['role'].id, 'team': entry['team'], 'match': entry['match']}
        for entry in entries
    ]


def overwrites_for_channel_type(entries: list[dict], channel_type: str):
    """Build ``(role, PermissionOverwrite)`` pairs for a channel type.

    ``channel_type`` is one of ``categories``, ``team_channels`` or
    ``match_channels``. Categories receive visibility whenever the role has any
    access to team channels (which live under the category).
    """
    pairs: list[tuple[discord.Role, discord.PermissionOverwrite]] = []
    for entry in entries:
        role = entry.get('role')
        if role is None:
            continue
        if channel_type == 'categories':
            # Categories just need visibility if the role can see team channels.
            if _normalize_level(entry.get('team')) != 'none':
                pairs.append((role, discord.PermissionOverwrite(view_channel=True)))
            continue
        level = entry.get('team') if channel_type == 'team_channels' else entry.get('match')
        perms = level_permissions(level)
        if perms:
            pairs.append((role, discord.PermissionOverwrite(**perms)))
    return pairs


def override_options() -> list[dict]:
    """Return the selectable permission levels for the admin page."""
    return [
        {'value': key, 'label': OVERRIDE_LEVELS[key]['label'], 'description': OVERRIDE_LEVELS[key]['description']}
        for key in OVERRIDE_LEVEL_ORDER
    ]


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


def default_role_levels(guild: discord.Guild) -> dict[int, dict]:
    """Effective default access per role, before any overrides.

    Returns ``{role_id: {"team": level, "match": level}}``. Built-in access roles
    already get send access to team/match channels, so the UI can flag overrides
    that are redundant (or that deliberately change the default).
    """
    levels: dict[int, dict] = {}

    def entry(role_id: int) -> dict:
        return levels.setdefault(role_id, {'team': 'none', 'match': 'none'})

    for role in _access_roles(guild, CATEGORY_ACCESS):
        entry(role.id)['team'] = 'send'
    for role in _access_roles(guild, MATCH_ACCESS):
        entry(role.id)['match'] = 'send'
    return levels


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
        Optional raw role-overrides payload: a legacy string, a list of
        ``{"role_id": id, "team": level, "match": level}`` entries, or an older
        preset-based config.
    include_assignments:
        When True, query Citadel teams for the captains that would be assigned.
    already_started:
        Whether divisions already exist for this league in the database.
    """
    rosters = list(_field(league, 'rosters', []) or [])
    div_names = _division_names(rosters)

    override_entries, missing_overrides, legacy_overrides = normalize_role_overrides(guild, role_overrides)
    category_access = _access_roles(guild, CATEGORY_ACCESS)
    team_access = _access_roles(guild, TEAM_ACCESS)
    match_access = _access_roles(guild, MATCH_ACCESS)
    defaults = default_role_levels(guild)

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
            'entries': [
                {
                    'role': {
                        **_role_ref(entry['role']),
                        'default_team': defaults.get(entry['role'].id, {'team': 'none'})['team'],
                        'default_match': defaults.get(entry['role'].id, {'match': 'none'})['match'],
                        'is_default': (
                            defaults.get(entry['role'].id, {}).get('team', 'none') != 'none'
                            or defaults.get(entry['role'].id, {}).get('match', 'none') != 'none'
                        ),
                    },
                    'team': entry['team'],
                    'match': entry['match'],
                }
                for entry in override_entries
            ],
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
