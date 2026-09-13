"""Development-only fake tournament generator.

Creates a complete, realistic facsimile of a running tournament: Discord
categories, division roles, team roles and channels, match channels, tracked
channels, match schedules, match logs, comms logs and launchpad entries — plus a
Citadel fixture so every fake league/team/roster/match resolves exactly like the
live API would.
"""

import asyncio
import datetime
import json
import random

import discord

from modules.citadel import FAKE_LEAGUE_ID, FAKE_LEAGUE_NAME, FAKE_LEAGUE_SHORTCODE
from modules.Drawbridge.checks import Checks
from modules.logging_config import get_logger

logger = get_logger('drawbridge.web.dev_fake', 'web.log')
checks = Checks()

# IDs live inside the fake ranges the Citadel wrapper feigns (see modules/citadel).
TEAM_ID_BASE = 500000
MATCH_ID_BASE = 510000
USER_ID_BASE = 600000

TEAMS_PER_DIV = 6

CATEGORY_ACCESS = ('HEAD', 'ADMIN', '!AC', 'TRIAL', 'DEVELOPER', 'APPROVED', '!UNAPPROVED', 'BOT')
TEAM_ACCESS = ('HEAD', 'ADMIN', 'TRIAL', 'DEVELOPER', 'BOT')

DIV_NAMES = ["Premiership", "Division 1", "Division 2"]
TEAM_NAMES_PER_DIV = [
    ["Fury", "Venom", "Thunder", "Blaze", "Storm", "Shadow"],
    ["Impact", "Vortex", "Phoenix", "Reapers", "Titans", "Nemesis"],
    ["Apex", "Carnage", "Havoc", "Rampage", "Wrath", "Onslaught"],
]

RR_MATCHUPS = [
    [(0, 5), (1, 4), (2, 3)],
    [(0, 4), (5, 3), (1, 2)],
    [(0, 3), (4, 2), (5, 1)],
    [(0, 2), (3, 1), (4, 5)],
    [(0, 1), (2, 5), (3, 4)],
]

PLAYOFF_MATCHUPS = [
    [(0, 3), (1, 2)],
    [(0, 1)],
]

MAPS_RR = [
    "cp_snakewater_final1", "cp_process_final", "cp_badlands",
    "cp_gullywash_final1", "cp_metalworks_final", "cp_sunshine",
    "cp_reckoner_b1", "cp_sultry_b8", "koth_product_final",
    "koth_lakeside_final", "pl_upward", "pl_swiftwater_ugc",
]

MAPS_PLAYOFF = [
    "cp_snakewater_final1", "cp_process_final", "cp_badlands",
    "cp_gullywash_final1", "cp_metalworks_final", "koth_product_final",
]

RINGER_NAMES = [
    "LeetPanda", "xX_Sniper_Xx", "MLGPro42", "Scout_Master",
    "Pyro_God", "DemoKnight99", "MedicMain", "SoldierMain",
    "EngineerGaming", "HeavyWeaponsGuy", "Spy_Sapper",
]

PLAYER_SUFFIX = ["", "Alt", "Ringer", "Sixth", "Backup", "Sub", "Coach"]

ROLE_WEIGHTS = [
    ("player_home", 0.35), ("player_away", 0.30),
    ("admin", 0.12), ("caster", 0.10),
    ("staff", 0.08), ("head_admin", 0.03), ("director", 0.02),
]

MESSAGE_TEMPLATES = [
    "yo when are we playing this week?",
    "we can do sunday 8pm if that works",
    "can we push to monday? got a ringer issue",
    "need a ringer for this match, anyone available?",
    "I can ringer for you guys, add me on steam",
    "we have a full roster for tonight, see you then",
    "any chance we can reschedule to tuesday?",
    "server will be up in 5 minutes",
    "gg wp, that was a close one",
    "nice holds on last, your demo was on fire",
    "can we get an admin? opponent using a banned player",
    "admin here, that player has been approved as a ringer",
    "match submitted, logs are up",
    "logs confirmed, good game",
    "we need 5 more minutes, our soldier is reconnecting",
    "ready to go, start the match",
    "we forfeit, can't field a team tonight",
    "we found a ringer, match is back on for 8:30",
    "casters joining, give us 2 mins",
    "stream is live at twitch.tv/tf2casts",
    "waiting in server, ready when you are",
    "our medic is running late, 10 more mins please",
    "thanks for the ringer, really saved us there",
    "we can play thursday instead if that suits",
    "admin ruling: match goes ahead as scheduled",
]


def pick_role():
    r = random.random()
    cumul = 0
    for role, weight in ROLE_WEIGHTS:
        cumul += weight
        if r <= cumul:
            return role
    return "player_home"


def generate_logs_text(match_id: int, div_name: str, home: str, away: str, count: int, week_past: bool):
    logs = []
    base_ts = datetime.datetime(2026, 6, 1, 18, 0, 0) + datetime.timedelta(hours=random.randint(0, 168 * 3))

    days_before = random.randint(1, 5) if not week_past else random.randint(1, 14)

    for i in range(count):
        ts = base_ts - datetime.timedelta(days=days_before - i * 0.02)
        role = pick_role()
        tmpl = random.choice(MESSAGE_TEMPLATES)
        user = random.choice(RINGER_NAMES)

        msg = tmpl.format(home=home, away=away, div=div_name)

        logs.append({
            'match_id': match_id,
            'user_name': user,
            'user_id': random.randint(100000000000000000, 999999999999999999),
            'message_content': msg,
            'log_type': 'CREATE',
            'role_type': role,
            'log_timestamp': ts.strftime('%Y-%m-%d %H:%M:%S'),
        })
    return logs


# ── Fixture construction ──────────────────────────────────────

def _fake_discord_id() -> int:
    """A Discord snowflake that deliberately does not belong to a real member."""
    return random.randint(100000000000000000, 999999999999999999)


def _make_user(uid: int, name: str, discord_id, is_captain: bool) -> dict:
    return {
        'id': uid,
        'name': name,
        'is_captain': is_captain,
        'description': 'Development fake player',
        'created_at': '2026-01-01T00:00:00Z',
        'profile_url': f'https://ozfortress.com/users/{uid}',
        'steam_32': str(uid),
        'steam_64': 76561198000000000 + uid,
        'steam_id3': f'[U:1:{uid}]',
        'discord_id': discord_id,
        'teams': [],
        'rosters': [],
    }


def _round_name(round_number: int) -> str:
    if round_number <= 5:
        return f'Week {round_number}'
    if round_number == 6:
        return 'Semi-Final'
    return 'Grand Final'


def build_fixture(admin_discord_id=None) -> dict:
    """Build a full fake tournament fixture (Citadel-shaped dictionaries)."""
    rosters: dict[int, dict] = {}
    teams: dict[int, dict] = {}
    matches: dict[int, dict] = {}
    users: dict[int, dict] = {}
    league_rosters: list[dict] = []
    league_matches: list[dict] = []

    user_counter = USER_ID_BASE

    def make_player(team_name, slot, discord_id, is_captain):
        nonlocal user_counter
        user_counter += 1
        uid = user_counter
        name = f'{team_name} {PLAYER_SUFFIX[slot]}'.strip() or f'{team_name} Player'
        user = _make_user(uid, name, discord_id, is_captain)
        users[uid] = user
        return user

    team_id_counter = TEAM_ID_BASE
    for div_idx, div_name in enumerate(DIV_NAMES):
        for team_idx, team_name in enumerate(TEAM_NAMES_PER_DIV[div_idx]):
            team_id_counter += 1
            tid = team_id_counter
            players = []
            for slot in range(len(PLAYER_SUFFIX)):
                is_captain = slot == 0
                # Make the invoking admin the captain of the first team so at
                # least one real role assignment is demonstrable.
                if is_captain and admin_discord_id and div_idx == 0 and team_idx == 0:
                    discord_id = admin_discord_id
                else:
                    discord_id = _fake_discord_id()
                players.append(make_player(team_name, slot, discord_id, is_captain))

            roster = {
                'id': tid,
                'team_id': tid,
                'name': team_name,
                'description': f'{team_name} roster',
                'division': div_name,
                'disbanded': False,
                'players': players,
                'matches': [],
            }
            team = {
                'id': tid,
                'name': team_name,
                'description': f'{team_name} team',
                'avatar_url': '',
                'avatar_thumb_url': '',
                'avatar_icon_url': '',
                'players': players,
                'rosters': [roster],
            }
            rosters[tid] = roster
            teams[tid] = team
            league_rosters.append(roster)

    def team_id_for(div_idx, rel) -> int:
        return TEAM_ID_BASE + div_idx * TEAMS_PER_DIV + rel + 1

    match_id_counter = MATCH_ID_BASE

    def add_match(div_idx, home_rel, away_rel, round_number, status) -> dict:
        nonlocal match_id_counter
        match_id_counter += 1
        mid = match_id_counter
        home = rosters[team_id_for(div_idx, home_rel)]
        away = rosters[team_id_for(div_idx, away_rel)]
        match = {
            'id': mid,
            'forfeit_by': 'no_forfeit',
            'status': status,
            'round_name': _round_name(round_number),
            'round_number': round_number,
            'notice': '',
            'created_at': '2026-01-01T00:00:00Z',
            'league': {'id': FAKE_LEAGUE_ID, 'name': FAKE_LEAGUE_NAME, 'description': 'Development fake league'},
            'home_team': home,
            'away_team': away,
            'league_id': FAKE_LEAGUE_ID,
        }
        matches[mid] = match
        league_matches.append(match)
        return match

    for round_idx, matchups in enumerate(RR_MATCHUPS):
        round_number = round_idx + 1
        for div_idx in range(len(DIV_NAMES)):
            for home_rel, away_rel in matchups:
                if round_number <= 1:
                    status = 'confirmed'
                elif round_number == 2:
                    status = 'confirmed' if random.random() > 0.3 else 'submitted_by_home_team'
                elif round_number == 3:
                    status = random.choice(['submitted_by_home_team', 'submitted_by_away_team', 'pending'])
                else:
                    status = 'pending'
                add_match(div_idx, home_rel, away_rel, round_number, status)

    for semi_idx in range(2):
        for div_idx in range(len(DIV_NAMES)):
            home_rel, away_rel = PLAYOFF_MATCHUPS[0][semi_idx]
            add_match(div_idx, home_rel, away_rel, 6, 'pending')

    for div_idx in range(len(DIV_NAMES)):
        home_rel, away_rel = PLAYOFF_MATCHUPS[1][0]
        add_match(div_idx, home_rel, away_rel, 7, 'pending')

    league = {
        'id': FAKE_LEAGUE_ID,
        'name': FAKE_LEAGUE_NAME,
        'description': 'Development fake league (generated for local testing)',
        'rosters': league_rosters,
        'matches': league_matches,
    }

    return {
        'league': league,
        'shortcode': FAKE_LEAGUE_SHORTCODE,
        'rosters': rosters,
        'teams': teams,
        'matches': matches,
        'users': users,
    }


# ── Discord helpers ───────────────────────────────────────────

def _access_roles(guild: discord.Guild, keywords) -> list[discord.Role]:
    roles = []
    seen = set()
    for role_id in checks._get_role_ids(*keywords):
        role = guild.get_role(role_id)
        if role is not None and role.id not in seen:
            seen.add(role.id)
            roles.append(role)
    return roles


async def _safe(coro, retries=4):
    """Await a Discord call, retrying on 429 rate limits."""
    for attempt in range(retries):
        try:
            return await coro
        except discord.HTTPException as e:
            if e.status == 429:
                retry_after = getattr(e, 'retry_after', 1.0)
                logger.warning(f'Fake tournament: 429 on attempt {attempt + 1}, retrying in {retry_after}s')
                await asyncio.sleep(retry_after + 0.5)
                continue
            raise
    raise RuntimeError('Discord API call failed after repeated rate limits')


async def _safe_delete(obj):
    try:
        await _safe(obj.delete(reason='Fake tournament cleanup'))
    except Exception as e:
        logger.warning(f'Fake tournament cleanup could not delete {obj!r}: {e}')


async def _send_welcome(db, cit, channel: discord.TextChannel, team: dict, role: discord.Role, div_name: str, shortcode: str):
    """Post the same style of welcome embed a real tournament would post."""
    try:
        from web.template_helper import get_template, set_db as template_set_db
        from modules.Drawbridge.functions import Functions
        template_set_db(db)
        raw = get_template('teams.json')
        if raw:
            funcs = Functions(db, cit)
            subs = {
                '{TEAM_MENTION}': f'<@&{role.id}>',
                '{TEAM_NAME}': team['name'],
                '{TEAM_ID}': str(team['id']),
                '{DIVISION}': div_name,
                '{LEAGUE_NAME}': FAKE_LEAGUE_NAME,
                '{LEAGUE_SHORTCODE}': shortcode,
                '{CHANNEL_ID}': str(channel.id),
                '{CHANNEL_LINK}': f'<#{channel.id}>',
            }
            msg = json.loads(funcs.substitute_strings_in_embed(str(raw), subs))
            msg['embed'] = discord.Embed(**msg['embeds'][0])
            del msg['embeds']
            await channel.send(**msg)
            return
    except Exception as e:
        logger.warning(f'Fake tournament welcome template failed for {team["name"]}: {e}')
    try:
        embed = discord.Embed(
            title=f'Welcome to {team["name"]}',
            description=f'{role.mention} — {div_name} — {FAKE_LEAGUE_NAME} ({shortcode})',
            color=discord.Color.blurple(),
        )
        await channel.send(content=role.mention, embed=embed)
    except Exception as e:
        logger.warning(f'Fake tournament welcome message failed for {team["name"]}: {e}')


# ── Logs ──────────────────────────────────────────────────────

def _insert_logs(db, fixture: dict):
    """Insert match logs and comms logs for completed/submitted matches."""
    teams = fixture['teams']
    with db.connection.get_connection() as conn:
        cursor = conn.cursor()
        log_id_counter = 4000000
        for m in fixture['matches'].values():
            status = m['status']
            if status not in ('confirmed', 'submitted_by_home_team', 'submitted_by_away_team'):
                if random.random() > 0.5:
                    continue
            home = teams[m['home_team']['team_id']]
            away = teams[m['away_team']['team_id']]
            div_name = m['home_team']['division']
            is_past = m['round_number'] <= 3
            completed = status == 'confirmed'
            submitted = status.startswith('submitted')

            if completed or submitted:
                num_maps = 2 if m['round_number'] <= 5 else 3
                map_pool = MAPS_RR if m['round_number'] <= 5 else MAPS_PLAYOFF
                for _ in range(num_maps):
                    map_name = random.choice(map_pool)
                    log_id_counter += 1
                    red_score = random.randint(0, 5)
                    blu_score = random.randint(0, 5)
                    while red_score == blu_score:
                        blu_score = random.randint(0, 5)
                    played_at = datetime.datetime(2026, 6, 1, 18, 0, 0) - datetime.timedelta(
                        days=random.randint(0, 30), hours=random.randint(0, 5))
                    cursor.execute(
                        """INSERT INTO match_logs (match_id, log_id, map_name, submitted_by, submitted_at, red_team_id, blu_team_id, red_score, blu_score, played_at, home_overlap, home_roster_size, away_overlap, away_roster_size, verified)
                           VALUES (?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (m['id'], str(log_id_counter), map_name,
                         random.choice([111111111111111111, 222222222222222222, 333333333333333333]),
                         home['team_id'] if random.random() > 0.5 else away['team_id'],
                         away['team_id'] if random.random() > 0.5 else home['team_id'],
                         red_score, blu_score,
                         played_at.strftime('%Y-%m-%d %H:%M:%S'),
                         random.randint(5, 9), 9, random.randint(5, 9), 9,
                         1 if completed else 0)
                    )

            num_logs = random.randint(8, 20) if completed else (random.randint(3, 10) if submitted else random.randint(1, 4))
            comms = generate_logs_text(m['id'], div_name, home['name'], away['name'], num_logs, is_past)
            db_match = db.matches.get_by_id(m['id']) or {}
            channel_id = db_match.get('channel_id')
            for cl in comms:
                cursor.execute(
                    """INSERT INTO logs (match_id, team_id, user_id, user_name, user_nick, user_avatar, message_id, message_content, message_additionals, log_type, log_timestamp, role_type, channel_id)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (cl['match_id'],
                     home['team_id'] if cl['role_type'] in ['player_home', 'home'] else away['team_id'],
                     cl['user_id'], cl['user_name'], cl['user_name'], '',
                     random.randint(100000000000000000, 999999999999999999),
                     cl['message_content'], '',
                     cl['log_type'], cl['log_timestamp'],
                     cl['role_type'], channel_id)
                )
        conn.commit()


# ── Generation / cleanup ──────────────────────────────────────

async def generate_fake_tournament(bot, db, cit, guild, tournament_cog=None,
                                   admin_discord_id=None, force=False, progress=None):
    """Create a complete fake tournament: Discord channels/roles + DB + Citadel fixture.

    Returns ``(league_id, message)``.
    """
    def p(pct, msg):
        if progress:
            try:
                progress(pct, msg)
            except Exception:
                pass

    existing = db.leagues.get_by_id(FAKE_LEAGUE_ID)
    if existing:
        if not force:
            return FAKE_LEAGUE_ID, f"Fake tournament {FAKE_LEAGUE_NAME} already exists (league_id={FAKE_LEAGUE_ID})."
        p(2, 'Cleaning up existing fake tournament...')
        await cleanup_fake_tournament(bot, db, cit, guild)

    if guild is None:
        raise ValueError('Discord guild is not available; cannot generate channels.')

    fixture = build_fixture(admin_discord_id)
    cit.set_fake_fixture(fixture)

    shortcode = FAKE_LEAGUE_SHORTCODE
    db.leagues.insert({
        'league_id': FAKE_LEAGUE_ID,
        'league_name': FAKE_LEAGUE_NAME,
        'league_shortcode': shortcode,
    })

    category_roles = _access_roles(guild, CATEGORY_ACCESS)

    p(5, 'Creating division categories and roles...')
    div_ids: dict[str, int] = {}
    categories: dict[str, discord.CategoryChannel] = {}
    for div_name in DIV_NAMES:
        overrides = {guild.default_role: discord.PermissionOverwrite(view_channel=False)}
        for role in category_roles:
            overrides[role] = discord.PermissionOverwrite(view_channel=True, send_messages=True)
        category = await _safe(guild.create_category(f'{div_name} - {shortcode}', overwrites=overrides))
        role = await _safe(guild.create_role(name=f'{div_name} - {shortcode}'))
        div_ids[div_name] = db.divisions.insert({
            'league_id': FAKE_LEAGUE_ID,
            'division_name': div_name,
            'role_id': role.id,
            'category_id': category.id,
        })
        categories[div_name] = category

    p(20, 'Creating team roles and channels...')
    teams = fixture['teams']
    total_teams = len(teams)
    for idx, team in enumerate(teams.values()):
        div_name = team['rosters'][0]['division']
        team_role = await _safe(guild.create_role(name=f'{team["name"][:20]} ({shortcode})', mentionable=True))
        overrides = {
            guild.default_role: discord.PermissionOverwrite(view_channel=False, send_messages=False),
            team_role: discord.PermissionOverwrite(view_channel=True, send_messages=True),
        }
        for role in category_roles:
            overrides[role] = discord.PermissionOverwrite(view_channel=True, send_messages=True)
        channel = await _safe(guild.create_text_channel(
            f'🛡️{team["name"][:20]} ({shortcode})',
            category=categories[div_name],
            overwrites=overrides,
        ))
        db.teams.insert({
            'roster_id': team['id'],
            'team_id': team['id'],
            'league_id': FAKE_LEAGUE_ID,
            'role_id': team_role.id,
            'team_channel': channel.id,
            'division': div_ids[div_name],
            'team_name': team['name'],
        })
        try:
            db.tracked_channels.upsert_by_channel({
                'channel_id': channel.id,
                'channel_type': 'team',
                'team_id': team['id'],
                'league_id': FAKE_LEAGUE_ID,
                'active': 1,
            })
        except Exception as e:
            logger.warning(f'Fake tournament could not track team channel {channel.id}: {e}')
        await _send_welcome(db, cit, channel, team, team_role, div_name, shortcode)
        p(20 + int(35 * (idx + 1) / max(total_teams, 1)),
          f'Created team {idx + 1}/{total_teams}: {team["name"]}')

    match_list = list(fixture['matches'].values())
    if tournament_cog is not None and match_list:
        p(58, 'Creating match channels...')
        for idx, match in enumerate(match_list):
            try:
                cit_match = cit.getMatch(match['id'])
                await tournament_cog._generate_match(cit_match)
            except Exception as e:
                logger.error(f'Fake tournament failed to generate match {match["id"]}: {e}', exc_info=True)
            p(58 + int(30 * (idx + 1) / max(len(match_list), 1)),
              f'Created match {idx + 1}/{len(match_list)}: {match["round_name"]}')
    elif match_list:
        logger.warning('Fake tournament: no Tournament cog supplied; skipping match channels.')

    p(90, 'Generating match logs and comms...')
    try:
        _insert_logs(db, fixture)
    except Exception as e:
        logger.error(f'Fake tournament log generation failed: {e}', exc_info=True)

    # Archive early completed rounds so the tournament looks like it is mid-season.
    archived = 0
    for match in match_list:
        if match['round_number'] <= 2 and match['status'] == 'confirmed':
            try:
                db.archive_match(match['id'])
                db.match_schedules.delete_by_match(match['id'])
                archived += 1
            except Exception as e:
                logger.warning(f'Fake tournament could not archive match {match["id"]}: {e}')

    if tournament_cog is not None:
        p(95, 'Assigning captain roles...')
        try:
            await tournament_cog._assign_roles(FAKE_LEAGUE_ID)
        except Exception as e:
            logger.warning(f'Fake tournament role assignment failed: {e}')
        p(98, 'Updating launchpad...')
        try:
            await tournament_cog.update_launchpad()
        except Exception as e:
            logger.warning(f'Fake tournament launchpad update failed: {e}')

    p(100, 'Fake tournament generated.')
    total_matches = len(match_list)
    message = (
        f"Generated {FAKE_LEAGUE_NAME}: {len(DIV_NAMES)} divisions, "
        f"{total_teams} teams, {total_matches} matches ({archived} archived) with "
        f"categories, roles, channels, logs and launchpad entries."
    )
    return FAKE_LEAGUE_ID, message


async def cleanup_fake_tournament(bot, db, cit, guild):
    """Remove all fake tournament data from Discord and the DB."""
    divs = db.divisions.get_by_league(FAKE_LEAGUE_ID)
    teams = db.teams.get_by_league(FAKE_LEAGUE_ID)
    matches = db.matches.get_by_league(FAKE_LEAGUE_ID)

    if guild is not None:
        for m in matches:
            cid = m.get('channel_id')
            channel = guild.get_channel(cid) if cid else None
            if channel is not None:
                await _safe_delete(channel)
        for t in teams:
            cid = t.get('team_channel')
            channel = guild.get_channel(cid) if cid else None
            if channel is not None:
                await _safe_delete(channel)
        for d in divs:
            cid = d.get('category_id')
            category = guild.get_channel(cid) if cid else None
            if category is not None:
                await _safe_delete(category)
        for t in teams:
            role = guild.get_role(t['role_id']) if t.get('role_id') else None
            if role is not None:
                await _safe_delete(role)
        for d in divs:
            role = guild.get_role(d['role_id']) if d.get('role_id') else None
            if role is not None:
                await _safe_delete(role)

    for m in matches:
        try:
            db.match_logs.delete_by_match(m['match_id'])
        except Exception:
            pass
        try:
            db.logs._execute_query("DELETE FROM logs WHERE match_id = ?", (m['match_id'],))
        except Exception:
            pass

    for cleanup in (
        lambda: db.match_schedules.delete_by_league(FAKE_LEAGUE_ID),
        lambda: db.tracked_channels.delete_by_league(FAKE_LEAGUE_ID),
        lambda: db.matches.delete_by_league(FAKE_LEAGUE_ID),
        lambda: db.teams.delete_by_league(FAKE_LEAGUE_ID),
        lambda: db.divisions.delete_by_league(FAKE_LEAGUE_ID),
        lambda: db.leagues.delete(FAKE_LEAGUE_ID),
    ):
        try:
            cleanup()
        except Exception as e:
            logger.warning(f'Fake tournament DB cleanup step failed: {e}')

    if cit is not None:
        try:
            cit.clear_fake_fixture()
        except Exception:
            pass


def generate_fake_citadel_data(db):
    """Generate fake citadel-mimicking data for the tournament detail API."""
    divs = db.divisions.get_by_league(FAKE_LEAGUE_ID)

    all_rosters = db.teams.get_by_league(FAKE_LEAGUE_ID)
    roster_map = {}
    for r in all_rosters:
        roster_map[r['roster_id']] = {'team_id': r['team_id'], 'name': r['team_name']}

    all_matches = db.matches.get_by_league(FAKE_LEAGUE_ID)
    citadel_matches = []
    for m in all_matches:
        rn = m.get('round_number') or 1
        round_name = f"Week {rn}" if rn <= 5 else (f"Semi-Final" if rn == 6 else "Grand Final")

        status = 'pending'
        forfeit_by = 'no_forfeit'
        match_logs = db.match_logs.get_by_match(m['match_id'])
        if match_logs:
            all_verified = all(ml.get('verified') for ml in match_logs)
            if all_verified:
                status = 'confirmed'
            else:
                status = 'submitted_by_home_team'

        citadel_matches.append({
            'id': m['match_id'],
            'round_number': rn,
            'round_name': round_name,
            'status': status,
            'forfeit_by': forfeit_by,
        })

    cit_rounds = {}
    for cm in citadel_matches:
        rn = cm['round_number']
        cit_rounds.setdefault(rn, {
            'round_number': rn,
            'round_name': cm['round_name'] if rn > 5 else f"Week {rn}",
            'matches': [],
        })['matches'].append(cm)

    return {
        'citadel_matches': citadel_matches,
        'citadel_rounds': sorted(cit_rounds.values(), key=lambda x: x['round_number']),
        'roster_map': roster_map,
    }
