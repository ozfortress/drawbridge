#!/usr/bin/env node
// Records one live Citadel dev response per API GET type into fixtures/.
//
// Reads CITADEL_DEV_API_KEY from v2/.env.local (two directories up from this
// file). The key is never printed and never written: it only ever travels as
// the X-Api-Key request header, and any response that somehow contained it
// would abort the capture.
//
// Response bodies are written VERBATIM, not parse-and-reprint: Citadel
// serialises users.steam_64 and users.discord_id as JSON integers above
// Number.MAX_SAFE_INTEGER, and JSON.parse would silently corrupt them. The
// raw bytes are the contract the lossless parser in @drawbridge/citadel is
// tested against.
//
// Nothing is sanitised: every value in the seeded responses is fake (see
// seed.rb), so the fixtures are safe to commit.
//
// Usage (from v2/): node tools/citadel-dev/capture.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '../../.env.local');
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
const fixturesDir = join(here, 'fixtures');

const key = /^CITADEL_DEV_API_KEY=(.+)$/m.exec(readFileSync(envFile, 'utf8'))?.[1]?.trim();
if (!key) {
  console.error('CITADEL_DEV_API_KEY is missing from v2/.env.local');
  process.exit(1);
}

const base = (process.env.CITADEL_API_BASE_URL ?? 'http://127.0.0.1:3000/api/v1/').replace(
  /\/?$/,
  '/',
);

// One fixture per GET type of the Citadel client, plus extra match states.
const targets = [
  ['league.json', `leagues/${manifest.capture.league}`],
  ['match-confirmed.json', `matches/${manifest.capture.match_confirmed}`],
  ['match-pending.json', `matches/${manifest.capture.match_pending}`],
  ['match-bye.json', `matches/${manifest.capture.match_bye}`],
  ['roster.json', `rosters/${manifest.capture.roster}`],
  ['team.json', `teams/${manifest.capture.team}`],
  ['user.json', `users/${manifest.capture.user}`],
  ['user-by-steam-id.json', `users/steam_id/${manifest.capture.user_steam}`],
  ['user-by-discord-id.json', `users/discord_id/${manifest.capture.user_discord}`],
];

mkdirSync(fixturesDir, { recursive: true });
let failed = false;

for (const [file, route] of targets) {
  const response = await fetch(base + route, { headers: { 'X-Api-Key': key } });
  const body = await response.text();
  if (response.status !== 200) {
    console.error(`GET ${route} -> HTTP ${response.status}; ${file} not written`);
    failed = true;
    continue;
  }
  if (body.includes(key)) {
    // Defence in depth: the key is a request header, never response content.
    console.error(`GET ${route} -> response contains the API key; ${file} not written`);
    failed = true;
    continue;
  }
  try {
    JSON.parse(body); // validation only; the fixture keeps the raw bytes
  } catch {
    console.error(`GET ${route} -> body is not JSON; ${file} not written`);
    failed = true;
    continue;
  }
  writeFileSync(join(fixturesDir, file), body);
  console.log(`captured ${file} <- GET ${route} (${body.length} bytes)`);
}

// Spot checks: the fixtures must actually exercise the seeded paths the
// Drawbridge client depends on.
const rawTeam = readFileSync(join(fixturesDir, 'team.json'), 'utf8');
const team = JSON.parse(rawTeam);
const captains = team.team.players.filter((player) => player.is_captain === true);
if (captains.length === 1) {
  console.log(`team.json: exactly one player has is_captain=true (user ${captains[0].id})`);
} else {
  console.error(`team.json: expected exactly 1 captain, found ${captains.length}`);
  failed = true;
}

const rawDiscord = readFileSync(join(fixturesDir, 'user-by-discord-id.json'), 'utf8');
const discordMatch = /"discord_id"\s*:\s*(\d{18})/.exec(rawDiscord);
if (discordMatch) {
  console.log(`user-by-discord-id.json: raw 18-digit discord_id preserved (${discordMatch[1]})`);
} else {
  console.error('user-by-discord-id.json: no raw 18-digit discord_id in the fixture bytes');
  failed = true;
}

const rawUser = readFileSync(join(fixturesDir, 'user.json'), 'utf8');
const steamRe = new RegExp(`"steam_64"\\s*:\\s*${manifest.capture.user_steam}\\b`);
if (steamRe.test(rawUser)) {
  console.log(`user.json: steam_64 survives as a raw integer (${manifest.capture.user_steam})`);
} else {
  console.error('user.json: steam_64 not preserved as a raw integer');
  failed = true;
}

const byeMatch = JSON.parse(readFileSync(join(fixturesDir, 'match-bye.json'), 'utf8'));
if (byeMatch.match.status === 'confirmed' && byeMatch.match.away_team == null) {
  console.log('match-bye.json: away_team is null and the status is confirmed');
} else {
  console.error(
    `match-bye.json: unexpected shape (status=${byeMatch.match.status}, away_team=${byeMatch.match.away_team})`,
  );
  failed = true;
}

const league = JSON.parse(readFileSync(join(fixturesDir, 'league.json'), 'utf8'));
console.log(
  `league.json: ${league.league.rosters?.length ?? 'no'} rosters, ` +
    `${league.league.matches?.length ?? 'no'} matches, keys: ${Object.keys(league.league).join(', ')}`,
);

process.exit(failed ? 1 : 0);
