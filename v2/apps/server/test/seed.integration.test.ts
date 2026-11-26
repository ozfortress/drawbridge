import { type Database, guilds, leagueMemberships, leagueRoles, leagues } from '@drawbridge/db';
import {
  closeTestDatabase,
  prepareTestDatabase,
  resetTestDatabase,
  testDatabaseAvailable,
} from '@drawbridge/testkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEV_GUILD_ID, seedDevelopmentLeague } from '../src/seed.js';

const ROOT_ID = '136264506933248001';
const available = await testDatabaseAvailable();

describe.skipIf(!available)('development seed (integration)', () => {
  let database: Database;

  beforeAll(async () => {
    database = await prepareTestDatabase();
  });

  afterAll(async () => {
    if (database) await closeTestDatabase(database);
  });

  beforeEach(async () => {
    await resetTestDatabase(database.db);
  });

  it('creates one complete league when run twice', async () => {
    const input = { rootAdminDiscordIds: [ROOT_ID], citadelLeagueId: 9100 };
    const first = await seedDevelopmentLeague(database.db, input);
    const second = await seedDevelopmentLeague(database.db, input);

    expect(second).toEqual(first);
    expect(await database.db.select().from(guilds)).toHaveLength(1);
    expect(await database.db.select().from(leagues)).toHaveLength(1);

    const roles = await database.db.select().from(leagueRoles);
    expect(roles.map((role) => role.name).sort()).toEqual([
      'Admin',
      'Caster',
      'Director',
      'Player',
      'Trial',
    ]);

    const memberships = await database.db.select().from(leagueMemberships);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.discordId).toBe(ROOT_ID);
    expect(memberships[0]?.leagueRoleId).toBe(roles.find((role) => role.name === 'Director')?.id);
    expect(first.guildId).toBe(DEV_GUILD_ID);
  });
});
