import random
import datetime
import math

FAKE_LEAGUE_ID = 99999
FAKE_LEAGUE_NAME = "ETF2L Season 34"
FAKE_LEAGUE_SHORTCODE = "ETF2L34"
BASE_MATCH_ID = 500000

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

        msg = tmpl.format(
            home=home, away=away, div=div_name
        )

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


def cleanup_fake_tournament(db):
    """Remove all fake tournament data from DB."""
    existing = db.leagues.get_by_id(FAKE_LEAGUE_ID)
    if not existing:
        return
    divs = db.divisions.get_by_league(FAKE_LEAGUE_ID)
    for d in divs:
        matches = db.matches.get_by_division(d['id'])
        for m in matches:
            try:
                db.match_logs.delete_by_match(m['match_id'])
            except Exception:
                pass
            try:
                db.logs._execute_query("DELETE FROM logs WHERE match_id = ?", (m['match_id'],))
            except Exception:
                pass
        try:
            db.matches._execute_query("DELETE FROM matches WHERE division = ?", (d['id'],))
        except Exception:
            pass
        try:
            db.teams._execute_query("DELETE FROM teams WHERE division = ?", (d['id'],))
        except Exception:
            pass
    try:
        db.divisions._execute_query("DELETE FROM divisions WHERE league_id = ?", (FAKE_LEAGUE_ID,))
    except Exception:
        pass
    try:
        db.leagues.delete(FAKE_LEAGUE_ID)
    except Exception:
        pass


def generate_fake_tournament(db, force=False):
    """Generate all fake tournament data and insert into DB."""
    existing = db.leagues.get_by_id(FAKE_LEAGUE_ID)
    if existing:
        if force:
            cleanup_fake_tournament(db)
        else:
            return FAKE_LEAGUE_ID, f"Fake tournament {FAKE_LEAGUE_NAME} already exists (league_id={FAKE_LEAGUE_ID})"

    db.leagues.insert({
        'league_id': FAKE_LEAGUE_ID,
        'league_name': FAKE_LEAGUE_NAME,
        'league_shortcode': FAKE_LEAGUE_SHORTCODE,
    })

    div_ids = []
    for div_name in DIV_NAMES:
        db.divisions.insert({
            'division_name': div_name,
            'league_id': FAKE_LEAGUE_ID,
            'role_id': None,
            'category_id': None,
        })
    all_divs = db.divisions.get_by_league(FAKE_LEAGUE_ID)
    for div_name in DIV_NAMES:
        for d in all_divs:
            if d['division_name'] == div_name:
                div_ids.append(d['id'])
                break

    team_roster_ids = {}
    all_teams = []
    for div_idx, div_name in enumerate(DIV_NAMES):
        div_id = div_ids[div_idx]
        for team_idx, team_name in enumerate(TEAM_NAMES_PER_DIV[div_idx]):
            roster_id = 500000 + div_idx * 100 + team_idx + 1
            team_id = roster_id
            db.teams.insert({
                'roster_id': roster_id,
                'team_id': team_id,
                'league_id': FAKE_LEAGUE_ID,
                'role_id': None,
                'team_name': f"{team_name}",
                'team_channel': None,
                'division': div_id,
            })
            team_roster_ids[(div_idx, team_idx)] = roster_id
            all_teams.append({
                'roster_id': roster_id,
                'team_id': team_id,
                'name': team_name,
                'division': div_id,
                'div_idx': div_idx,
                'team_idx': team_idx,
            })

    conn = db.connection.get_connection()
    cursor = conn.cursor()
    match_id_counter = 0
    all_match_ids = []
    round_match_map = {}

    week_statuses = [
        {'completed': 1.0, 'submitted': 0.0, 'past': True},
        {'completed': 0.78, 'submitted': 0.11, 'past': True},
        {'completed': 0.33, 'submitted': 0.33, 'past': False},
        {'completed': 0.0, 'submitted': 0.0, 'past': False},
        {'completed': 0.0, 'submitted': 0.0, 'past': False},
    ]

    for round_idx, matchups in enumerate(RR_MATCHUPS):
        round_number = round_idx + 1
        status_info = week_statuses[round_idx] if round_idx < len(week_statuses) else {'completed': 0.0, 'submitted': 0.0, 'past': False}
        round_matches = []
        for div_idx in range(3):
            div_id = div_ids[div_idx]
            for home_rel, away_rel in matchups:
                match_id_counter += 1
                mid = BASE_MATCH_ID + match_id_counter
                home_roster = team_roster_ids[(div_idx, home_rel)]
                away_roster = team_roster_ids[(div_idx, away_rel)]
                channel_id = 100000000000000000 + mid if random.random() > 0.15 else None

                r = random.random()
                if r < status_info['completed']:
                    archived = 0
                    cit_status = 'confirmed'
                    cit_forfeit = 'no_forfeit'
                elif r < status_info['completed'] + status_info['submitted']:
                    archived = 0
                    cit_status = random.choice(['submitted_by_home_team', 'submitted_by_away_team'])
                    cit_forfeit = 'no_forfeit'
                else:
                    archived = 0
                    cit_status = 'pending'
                    cit_forfeit = 'no_forfeit'

                cursor.execute(
                    "INSERT INTO matches (match_id, division, team_home, team_away, channel_id, archived, league_id, round_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (mid, div_id, home_roster, away_roster, channel_id, archived, FAKE_LEAGUE_ID, round_number)
                )

                round_matches.append({
                    'id': mid,
                    'div_idx': div_idx,
                    'div_name': DIV_NAMES[div_idx],
                    'home': TEAM_NAMES_PER_DIV[div_idx][home_rel],
                    'away': TEAM_NAMES_PER_DIV[div_idx][away_rel],
                    'home_roster': home_roster,
                    'away_roster': away_roster,
                    'status': cit_status,
                    'forfeit_by': cit_forfeit,
                    'channel_id': channel_id,
                    'completed': cit_status == 'confirmed',
                    'submitted': cit_status.startswith('submitted'),
                    'pending': cit_status == 'pending',
                    'round_number': round_number,
                })
                all_match_ids.append(mid)

        round_match_map[round_number] = round_matches

    for semi_idx in range(2):
        round_number = 6
        round_matches = []
        for div_idx in range(3):
            div_id = div_ids[div_idx]
            home_rel, away_rel = PLAYOFF_MATCHUPS[0][semi_idx]
            match_id_counter += 1
            mid = BASE_MATCH_ID + match_id_counter
            home_roster = team_roster_ids[(div_idx, home_rel)]
            away_roster = team_roster_ids[(div_idx, away_rel)]
            channel_id = 100000000000000000 + mid if random.random() > 0.3 else None

            cursor.execute(
                "INSERT INTO matches (match_id, division, team_home, team_away, channel_id, archived, league_id, round_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (mid, div_id, home_roster, away_roster, channel_id, 0, FAKE_LEAGUE_ID, round_number)
            )

            round_matches.append({
                'id': mid,
                'div_idx': div_idx,
                'div_name': DIV_NAMES[div_idx],
                'home': TEAM_NAMES_PER_DIV[div_idx][home_rel],
                'away': TEAM_NAMES_PER_DIV[div_idx][away_rel],
                'home_roster': home_roster,
                'away_roster': away_roster,
                'status': 'pending',
                'forfeit_by': 'no_forfeit',
                'channel_id': channel_id,
                'completed': False,
                'submitted': False,
                'pending': True,
                'round_number': round_number,
            })
            all_match_ids.append(mid)

        round_match_map.setdefault(round_number, []).extend(round_matches)

    round_number = 7
    round_matches = []
    for div_idx in range(3):
        div_id = div_ids[div_idx]
        home_rel, away_rel = PLAYOFF_MATCHUPS[1][0]
        match_id_counter += 1
        mid = BASE_MATCH_ID + match_id_counter
        home_roster = team_roster_ids[(div_idx, home_rel)]
        away_roster = team_roster_ids[(div_idx, away_rel)]
        channel_id = 100000000000000000 + mid if random.random() > 0.5 else None

        cursor.execute(
            "INSERT INTO matches (match_id, division, team_home, team_away, channel_id, archived, league_id, round_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (mid, div_id, home_roster, away_roster, channel_id, 0, FAKE_LEAGUE_ID, round_number)
        )

        round_matches.append({
            'id': mid,
            'div_idx': div_idx,
            'div_name': DIV_NAMES[div_idx],
            'home': TEAM_NAMES_PER_DIV[div_idx][home_rel],
            'away': TEAM_NAMES_PER_DIV[div_idx][away_rel],
            'home_roster': home_roster,
            'away_roster': away_roster,
            'status': 'pending',
            'forfeit_by': 'no_forfeit',
            'channel_id': channel_id,
            'completed': False,
            'submitted': False,
            'pending': True,
            'round_number': round_number,
        })
        all_match_ids.append(mid)

    round_match_map.setdefault(round_number, []).extend(round_matches)

    log_id_counter = 4000000
    for round_number, matches in round_match_map.items():
        is_past = round_number <= 3
        for m in matches:
            if m['completed'] or m['submitted']:
                num_maps = 2 if round_number <= 5 else 3
                map_pool = MAPS_RR if round_number <= 5 else MAPS_PLAYOFF
                for map_i in range(num_maps):
                    map_name = random.choice(map_pool)
                    log_id_counter += 1
                    red_score = random.randint(0, 5)
                    blu_score = random.randint(0, 5)
                    while red_score == blu_score:
                        blu_score = random.randint(0, 5)
                    played_at = datetime.datetime(2026, 6, 1, 18, 0, 0) - datetime.timedelta(
                        days=random.randint(0, 30),
                        hours=random.randint(0, 5)
                    )
                    cursor.execute(
                        """INSERT INTO match_logs (match_id, log_id, map_name, submitted_by, submitted_at, red_team_id, blu_team_id, red_score, blu_score, played_at, home_overlap, home_roster_size, away_overlap, away_roster_size, verified)
                           VALUES (?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (m['id'], str(log_id_counter), map_name, random.choice([111111111111111111, 222222222222222222, 333333333333333333]),
                         m['home_roster'] if random.random() > 0.5 else m['away_roster'],
                         m['away_roster'] if random.random() > 0.5 else m['home_roster'],
                         red_score, blu_score,
                         played_at.strftime('%Y-%m-%d %H:%M:%S'),
                         random.randint(5, 9), 9, random.randint(5, 9), 9,
                         1 if m['completed'] else 0)
                    )

            if m['completed'] or m['submitted'] or m['pending']:
                num_logs = random.randint(8, 20) if m['completed'] else (random.randint(3, 10) if m['submitted'] else random.randint(1, 4))
                comms_logs = generate_logs_text(m['id'], m['div_name'], m['home'], m['away'], num_logs, is_past)
                for cl in comms_logs:
                    cursor.execute(
                        """INSERT INTO logs (match_id, team_id, user_id, user_name, user_nick, user_avatar, message_id, message_content, message_additionals, log_type, log_timestamp, role_type, channel_id)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (cl['match_id'], m['home_roster'] if cl['role_type'] in ['player_home', 'home'] else m['away_roster'],
                         cl['user_id'], cl['user_name'], cl['user_name'], '',
                         random.randint(100000000000000000, 999999999999999999),
                         cl['message_content'], '',
                         cl['log_type'], cl['log_timestamp'],
                         cl['role_type'], m.get('channel_id'))
                    )

    conn.commit()
    conn.close()

    total_matches = match_id_counter
    total_logs = sum(
        2 if m['completed'] or m['submitted'] else 0
        for matches in round_match_map.values() for m in matches
    )
    total_comms = sum(
        random.randint(8, 20) if m['completed'] else (random.randint(3, 10) if m['submitted'] else random.randint(1, 4))
        for matches in round_match_map.values() for m in matches
    )

    return FAKE_LEAGUE_ID, f"Generated {total_matches} matches ({total_logs} match logs, {total_comms} comm messages) across {len(DIV_NAMES)} divisions"


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
