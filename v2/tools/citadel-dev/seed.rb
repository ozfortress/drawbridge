# frozen_string_literal: true

# Drawbridge v2 -- seed data for the Citadel DEV instance.
# Plan reference: drawbridge-v2 plan 05-delivery.md section 1.1 ("Citadel dev setup").
#
# Creates, all fake:
#   * game / format / map rows,
#   * 96 users with realistic 17-digit Steam IDs; every third user has no
#     Discord ID, the rest carry unique 18-digit values (captains always do),
#   * 16 teams of six players, each with one captain grant
#     (grants_for(:edit, team).first_or_create! -> action_user_edit_team rows),
#   * a running league with two divisions ("Premier", "Open") of eight
#     approved rosters each,
#   * a hidden league for the 404 visibility path,
#   * 16 matches covering every status, every forfeit kind, one bye, and
#     round numbers 1-3 (two confirmed matches carry scored map rounds).
#
# The script is IDEMPOTENT: every row is looked up first (by fixed ID), so a
# second run creates nothing. Fixed IDs sit far above every existing dev row,
# so they cannot collide with owner-created data, and every touched id
# sequence is bumped past the highest inserted ID so the application keeps
# allocating safely.
#
# It never drops, resets or deletes anything and never touches API keys
# (the drawbridge-dev key is created separately per plan section 1.1 step 4).
#
# Usage (from E:\citadel\citadel, plan section 1.1):
#   docker compose -f docker-compose.dev.yml cp <repo>\v2\tools\citadel-dev\seed.rb web:/tmp/seed.rb
#   docker compose -f docker-compose.dev.yml exec web bin/rails runner /tmp/seed.rb
#
# Output:
#   SEED_MANIFEST_BEGIN ... SEED_MANIFEST_END  (JSON of created IDs; copy into manifest.json)
#   SEED_COUNTS <table=rows ...>               (row counts for the idempotency proof)

require 'json'

SEED = {
  game_id: 9_001,
  format_id: 9_002,
  map_ids: [9_010, 9_011, 9_012, 9_013, 9_014, 9_015],
  running_league_id: 9_100,
  hidden_league_id: 9_101,
  division_ids: [9_110, 9_111],
  first_user_id: 9_200,   # 96 users:   9_200 .. 9_295
  first_team_id: 9_300,   # 16 teams:  9_300 .. 9_315
  first_roster_id: 9_400, # 16 rosters: 9_400 .. 9_415
  first_match_id: 9_500   # 16 matches: 9_500 .. 9_515
}.freeze

USER_COUNT = 96
TEAM_SIZE = 6
TEAM_COUNT = 16
ROSTERS_PER_DIVISION = 8

def seed_user(i)
  # Every third user has no Discord ID; slot 0 of every team is its captain
  # (slot indices are 6k, and 6k + 1 is never divisible by 3), so every
  # captain carries an 18-digit Discord ID.
  discord_id = ((i + 1) % 3).zero? ? nil : 200_000_000_000_000_000 + (i + 1)
  User.find_or_create_by!(id: SEED[:first_user_id] + i) do |u|
    u.name = format('Dev Player %02d', i + 1)
    u.steam_id = 76_561_198_000_000_000 + (i + 1)
    u.discord_id = discord_id
    u.description = ''
  end
end

def seed_team(i, team_users)
  team = Team.find_or_create_by!(id: SEED[:first_team_id] + i) do |t|
    t.name = format('Dev Team %02d', i + 1)
    t.description = 'Seed team for Drawbridge v2 development.'
    t.created_by = team_users[0]
  end
  team_users.each { |u| Team::Player.find_or_create_by!(team_id: team.id, user_id: u.id) }

  # Captain: an explicit edit grant on the team (lib/auth model, table
  # action_user_edit_team). The team API response reports is_captain as
  # user.can?(:edit, team), so this row is what makes a captain a captain.
  team_users[0].grants_for(:edit, team).first_or_create!(team_id: team.id)
  team
end

def seed_match(offset, home_id:, away_id:, round:, status:, forfeit: :no_forfeit, rounds: [])
  League::Match.find_or_create_by!(id: SEED[:first_match_id] + offset) do |m|
    m.home_team_id = home_id
    m.away_team_id = away_id
    m.status = status
    m.forfeit_by = forfeit
    m.round_number = round
    m.round_name = "Round #{round}"
    m.has_winner = false
    m.allow_round_draws = false
    m.rounds_attributes = rounds.map do |map_id, home_score, away_score|
      { map_id:, home_team_score: home_score, away_team_score: away_score }
    end
  end
end

def bump_sequences!
  conn = ActiveRecord::Base.connection
  %w[games formats maps users teams leagues league_divisions league_rosters
     league_matches action_user_edit_team].each do |table|
    seq = conn.select_value("SELECT pg_get_serial_sequence('#{table}', 'id')")
    next if seq.nil?

    conn.execute(<<~SQL)
      SELECT setval(#{conn.quote(seq)},
                    GREATEST(COALESCE((SELECT MAX(id) FROM #{table}), 0),
                             (SELECT last_value FROM #{seq})),
                    true)
    SQL
  end
end

# Local variables must exist before the transaction block, otherwise Ruby
# makes the block-internal assignments block-local and the manifest below
# cannot see them.
game = format_row = maps = users = teams = nil
league = hidden_league = divisions = rosters = matches = nil

ActiveRecord::Base.transaction do
  game = Game.find_or_create_by!(id: SEED[:game_id]) { |g| g.name = 'Team Fortress 2' }

  format_row = Format.find_or_create_by!(id: SEED[:format_id]) do |f|
    f.name = '6v6'
    f.description = 'Standard six-a-side competitive format.'
    f.player_count = 6
    f.game = game
  end

  map_names = %w[
    cp_badlands
    cp_process_final
    cp_snakewater_final1
    koth_product_rc8
    pl_upward
    cp_granary_pro_rc8
  ]
  maps = map_names.each_with_index.map do |name, idx|
    Map.find_or_create_by!(id: SEED[:map_ids][idx]) do |m|
      m.name = name
      m.description = ''
      m.game = game
    end
  end

  users = USER_COUNT.times.map { |i| seed_user(i) }
  teams = TEAM_COUNT.times.map { |i| seed_team(i, users[i * TEAM_SIZE, TEAM_SIZE]) }

  league = League.find_or_create_by!(id: SEED[:running_league_id]) do |l|
    l.name = 'ozfortress Dev Sixes'
    l.description = 'Fake development league for Drawbridge v2; never use for real competition.'
    l.format = format_row
    l.status = :running
    l.category = ''
  end

  hidden_league = League.find_or_create_by!(id: SEED[:hidden_league_id]) do |l|
    l.name = 'ozfortress Dev Hidden'
    l.description = 'Fake hidden league proving the Citadel 404 visibility path.'
    l.format = format_row
    l.status = :hidden
    l.category = ''
  end

  divisions = %w[Premier Open].each_with_index.map do |name, idx|
    League::Division.find_or_create_by!(id: SEED[:division_ids][idx]) do |d|
      d.name = name
      d.league = league
    end
  end

  rosters = teams.each_with_index.map do |team, i|
    division = divisions[i / ROSTERS_PER_DIVISION]
    roster = League::Roster.find_or_create_by!(id: SEED[:first_roster_id] + i) do |r|
      r.team = team
      r.division = division
      r.name = team.name
      r.description = ''
      r.approved = true
      r.disbanded = false
      r.players_attributes = users[i * TEAM_SIZE, TEAM_SIZE].map { |u| { user_id: u.id } }
    end

    # Self-heal: guarantee all six players exist even for a pre-existing roster.
    users[i * TEAM_SIZE, TEAM_SIZE].each do |u|
      League::Roster::Player.find_or_create_by!(roster_id: roster.id, user_id: u.id)
    end
    roster
  end

  premier = rosters[0, ROSTERS_PER_DIVISION]
  open = rosters[ROSTERS_PER_DIVISION, ROSTERS_PER_DIVISION]

  matches = []
  # Division 1 (Premier): every status, every forfeit kind, rounds 1-3, one bye.
  matches << seed_match(0,  home_id: premier[0].id, away_id: premier[1].id, round: 1, status: :pending)
  matches << seed_match(1,  home_id: premier[2].id, away_id: premier[3].id, round: 1,
                        status: :submitted_by_home_team)
  matches << seed_match(2,  home_id: premier[4].id, away_id: premier[5].id, round: 1,
                        status: :submitted_by_away_team)
  matches << seed_match(3,  home_id: premier[6].id, away_id: premier[7].id, round: 1,
                        status: :confirmed,
                        rounds: [[SEED[:map_ids][0], 3, 1], [SEED[:map_ids][1], 2, 4],
                                 [SEED[:map_ids][2], 4, 2]])
  matches << seed_match(4,  home_id: premier[0].id, away_id: premier[1].id, round: 2,
                        status: :confirmed, forfeit: :home_team_forfeit)
  matches << seed_match(5,  home_id: premier[2].id, away_id: premier[3].id, round: 2,
                        status: :confirmed, forfeit: :away_team_forfeit)
  matches << seed_match(6,  home_id: premier[4].id, away_id: premier[5].id, round: 2,
                        status: :confirmed, forfeit: :mutual_forfeit)
  matches << seed_match(7,  home_id: premier[6].id, away_id: premier[7].id, round: 2,
                        status: :confirmed, forfeit: :technical_forfeit)
  matches << seed_match(8,  home_id: premier[0].id, away_id: premier[1].id, round: 3, status: :confirmed)
  matches << seed_match(9,  home_id: premier[2].id, away_id: premier[3].id, round: 3, status: :pending)
  matches << seed_match(10, home_id: premier[4].id, away_id: premier[5].id, round: 3,
                        status: :submitted_by_home_team)
  matches << seed_match(11, home_id: premier[6].id, away_id: nil, round: 3,
                        status: :confirmed) # bye
  # Division 2 (Open): a lighter set that still spans rounds 1-3.
  matches << seed_match(12, home_id: open[0].id, away_id: open[1].id, round: 1, status: :pending)
  matches << seed_match(13, home_id: open[2].id, away_id: open[3].id, round: 1,
                        status: :confirmed,
                        rounds: [[SEED[:map_ids][3], 5, 3], [SEED[:map_ids][4], 1, 2]])
  matches << seed_match(14, home_id: open[4].id, away_id: open[5].id, round: 2,
                        status: :submitted_by_away_team)
  matches << seed_match(15, home_id: open[6].id, away_id: open[7].id, round: 3, status: :pending)

  bump_sequences!
end

manifest = {
  'game_id' => game.id,
  'format_id' => format_row.id,
  'map_ids' => maps.map(&:id),
  'leagues' => { 'running' => league.id, 'hidden' => hidden_league.id },
  'division_ids' => divisions.map(&:id),
  'team_ids' => teams.map(&:id),
  'roster_ids' => rosters.map(&:id),
  'user_ids' => users.map(&:id),
  'captain_user_ids' => teams.each_with_index.map { |_t, i| users[i * TEAM_SIZE].id },
  'matches' => {
    'pending' => matches.select { |m| m.status == 'pending' }.map(&:id),
    'submitted_by_home_team' => matches.select { |m| m.status == 'submitted_by_home_team' }.map(&:id),
    'submitted_by_away_team' => matches.select { |m| m.status == 'submitted_by_away_team' }.map(&:id),
    'confirmed' => matches.select { |m| m.status == 'confirmed' }.map(&:id),
    'bye' => matches.select(&:bye?).map(&:id),
    'forfeits' => {
      'home_team' => matches.select { |m| m.home_team_forfeit? }.map(&:id),
      'away_team' => matches.select { |m| m.away_team_forfeit? }.map(&:id),
      'mutual' => matches.select { |m| m.mutual_forfeit? }.map(&:id),
      'technical' => matches.select { |m| m.technical_forfeit? }.map(&:id)
    }
  },
  'samples' => {
    'user_id_with_discord' => users[0].id,
    'user_id_without_discord' => users[2].id,
    'steam_id_17_digit' => users[0].steam_id.to_s,
    'discord_id_18_digit' => users[0].discord_id.to_s
  },
  # Convenience targets for tools/citadel-dev/capture.mjs.
  'capture' => {
    'league' => league.id,
    'match_confirmed' => matches[3].id,
    'match_pending' => matches[0].id,
    'match_bye' => matches[11].id,
    'roster' => rosters[0].id,
    'team' => teams[0].id,
    'user' => users[0].id,
    'user_steam' => users[0].steam_id.to_s,
    'user_discord' => users[0].discord_id.to_s
  }
}

puts 'SEED_MANIFEST_BEGIN'
puts JSON.pretty_generate(manifest)
puts 'SEED_MANIFEST_END'

counts = {
  users: User.count, teams: Team.count, team_players: Team::Player.count,
  team_transfers: Team::Transfer.count,
  leagues: League.count, divisions: League::Division.count,
  rosters: League::Roster.count, roster_players: League::Roster::Player.count,
  roster_transfers: League::Roster::Transfer.count,
  matches: League::Match.count, match_rounds: League::Match::Round.count,
  games: Game.count, formats: Format.count, maps: Map.count
}
grants = ActiveRecord::Base.connection.select_value('SELECT COUNT(*) FROM action_user_edit_team')
puts "SEED_COUNTS #{counts.map { |k, v| "#{k}=#{v}" }.join(' ')} grants=#{grants}"
