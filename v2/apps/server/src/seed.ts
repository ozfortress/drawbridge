import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseConfig } from '@drawbridge/config';
import {
  closeDatabase,
  createDatabase,
  createLeague,
  type Db,
  ensureGuild,
  ensureRootAdmins,
  findUserByDiscordId,
  leagueMemberships,
  listLeagueRoles,
  listLeaguesForActor,
  runMigrations,
} from '@drawbridge/db';

export const DEV_GUILD_ID = '1573554616371777546';

export interface DevelopmentSeedInput {
  readonly rootAdminDiscordIds: readonly string[];
  readonly citadelLeagueId: number;
}

export interface DevelopmentSeedResult {
  readonly guildId: string;
  readonly leagueId: string;
  readonly citadelLeagueId: number;
}

/** Creates the local development league without replacing existing user data. */
export async function seedDevelopmentLeague(
  db: Db,
  input: DevelopmentSeedInput,
): Promise<DevelopmentSeedResult> {
  const rootAdminDiscordId = input.rootAdminDiscordIds[0];
  if (!rootAdminDiscordId) {
    throw new Error('ROOT_ADMIN_DISCORD_IDS needs at least one Discord user ID for dev:seed');
  }
  if (!Number.isInteger(input.citadelLeagueId) || input.citadelLeagueId <= 0) {
    throw new Error('The seeded Citadel manifest has no valid running league id');
  }

  await ensureRootAdmins(db, input.rootAdminDiscordIds);
  const rootAdmin = await findUserByDiscordId(db, rootAdminDiscordId);
  if (!rootAdmin) throw new Error('The root admin could not be seeded');
  await ensureGuild(db, DEV_GUILD_ID, 'ozfortress Development');

  const actorLeagues = await listLeaguesForActor(db, {
    userId: rootAdmin.id,
    discordId: rootAdmin.discordId,
    tier: 'root',
  });
  const existing = actorLeagues.find(
    (candidate) =>
      candidate.guildId === DEV_GUILD_ID && candidate.citadelLeagueId === input.citadelLeagueId,
  );

  const league =
    existing ??
    (await createLeague(db, {
      guildId: DEV_GUILD_ID,
      citadelLeagueId: input.citadelLeagueId,
      name: 'ozfortress Dev Sixes',
      shortcode: 'OZL',
      createdByUserId: rootAdmin.id,
      createdByDiscordId: rootAdmin.discordId,
      requestId: 'dev-seed',
    }));

  const roles = await listLeagueRoles(db, league.id);
  const director = roles.find((role) => role.name === 'Director');
  if (!director) throw new Error('The Director role could not be seeded');

  await db
    .insert(leagueMemberships)
    .values({
      leagueId: league.id,
      userId: rootAdmin.id,
      discordId: rootAdmin.discordId,
      leagueRoleId: director.id,
      source: 'panel',
      createdByUserId: rootAdmin.id,
    })
    .onConflictDoUpdate({
      target: [leagueMemberships.leagueId, leagueMemberships.discordId],
      set: {
        userId: rootAdmin.id,
        leagueRoleId: director.id,
        source: 'panel',
        createdByUserId: rootAdmin.id,
      },
    });

  return {
    guildId: DEV_GUILD_ID,
    leagueId: league.id,
    citadelLeagueId: input.citadelLeagueId,
  };
}

/** Reads the id captured from the running dev Citadel instead of guessing one. */
async function seededCitadelLeagueId(): Promise<number> {
  const manifestUrl = new URL('../../../tools/citadel-dev/manifest.json', import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8')) as {
    leagues?: { running?: unknown };
  };
  const running = manifest.leagues?.running;
  if (typeof running !== 'number') {
    throw new Error('The Citadel dev manifest does not contain leagues.running');
  }
  return running;
}

function assertLocalSeedDatabase(connectionString: string): void {
  const url = new URL(connectionString);
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (!local || url.port !== '5433') {
    throw new Error('dev:seed only runs against local Postgres on port 5433');
  }
}

async function main(): Promise<void> {
  // The seed needs database configuration and root ids, not Discord credentials.
  const config = parseConfig({ ...process.env, RUN_MODE: 'migrate' });
  if (config.rootAdminDiscordIds.length === 0) {
    throw new Error('ROOT_ADMIN_DISCORD_IDS needs at least one Discord user ID for dev:seed');
  }
  const connectionString = config.databaseUrl.reveal();
  assertLocalSeedDatabase(connectionString);

  const database = createDatabase(connectionString, 2);
  try {
    await runMigrations(database.db);
    const result = await seedDevelopmentLeague(database.db, {
      rootAdminDiscordIds: config.rootAdminDiscordIds,
      citadelLeagueId: await seededCitadelLeagueId(),
    });
    console.log(
      `Seeded guild ${result.guildId}, league ${result.leagueId} (Citadel #${result.citadelLeagueId})`,
    );
  } finally {
    await closeDatabase(database);
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(`dev:seed failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
