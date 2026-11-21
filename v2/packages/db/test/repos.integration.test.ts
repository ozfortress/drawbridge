import {
  closeTestDatabase,
  prepareTestDatabase,
  resetTestDatabase,
  testDatabaseAvailable,
} from '@drawbridge/testkit';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConflictError,
  consumeInvite,
  createInvite,
  createLeague,
  createSession,
  type Database,
  ensureGuild,
  ensureRootAdmins,
  findUserByDiscordId,
  findUserById,
  findValidSession,
  listAudit,
  listLeagueRoles,
  listLeaguesForActor,
  listUsers,
  resolveLeagueAccess,
  revokeSession,
  sessions,
  setUserStatus,
  upsertDiscordUser,
} from '../src/index.js';

const available = await testDatabaseAvailable();

const ROOT_ID = '111111111111111111';
const GUEST_ID = '222222222222222222';
const OTHER_ID = '333333333333333333';
const GUILD_ID = '999999999999999999';

describe.skipIf(!available)('repositories (integration)', () => {
  let database: Database;

  beforeAll(async () => {
    database = await prepareTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase(database.db);
  });

  afterAll(async () => {
    if (database) await closeTestDatabase(database);
  });

  const db = () => database.db;

  describe('users and root bootstrap', () => {
    it('seeds root admins idempotently', async () => {
      await ensureRootAdmins(db(), [ROOT_ID, GUEST_ID]);
      await ensureRootAdmins(db(), [ROOT_ID]);
      const users = await listUsers(db());
      expect(users).toHaveLength(2);
      expect(users.every((user) => user.globalRole === 'root')).toBe(true);
    });

    it('creates guests on first sign-in and updates profile only', async () => {
      const first = await upsertDiscordUser(db(), {
        discordId: GUEST_ID,
        displayName: 'First',
        avatarHash: null,
      });
      expect(first.globalRole).toBe('guest');

      const second = await upsertDiscordUser(db(), {
        discordId: GUEST_ID,
        displayName: 'Second',
        avatarHash: 'abc',
      });
      expect(second.id).toBe(first.id);
      expect(second.displayName).toBe('Second');
      expect(second.globalRole).toBe('guest');
    });

    it('does not reactivate a disabled account on sign-in', async () => {
      const user = await upsertDiscordUser(db(), {
        discordId: GUEST_ID,
        displayName: 'X',
        avatarHash: null,
      });
      await setUserStatus(db(), user.id, 'disabled');
      const again = await upsertDiscordUser(db(), {
        discordId: GUEST_ID,
        displayName: 'Y',
        avatarHash: null,
      });
      expect(again.status).toBe('disabled');
    });
  });

  describe('invites', () => {
    it('promotes the user and applies league grants once', async () => {
      await ensureGuild(db(), GUILD_ID);
      const creator = await upsertDiscordUser(db(), {
        discordId: ROOT_ID,
        displayName: 'Root',
        avatarHash: null,
      });
      const league = await createLeague(db(), {
        guildId: GUILD_ID,
        citadelLeagueId: 42,
        name: 'Test League',
        shortcode: 'TST',
        createdByUserId: creator.id,
        createdByDiscordId: ROOT_ID,
      });
      const roles = await listLeagueRoles(db(), league.id);
      const caster = roles.find((role) => role.name === 'Caster')!;

      await createInvite(db(), {
        discordId: GUEST_ID,
        globalRole: 'helper',
        invitedBy: creator.id,
        leagueGrants: [{ leagueId: league.id, leagueRoleId: caster.id }],
      });
      await expect(
        createInvite(db(), {
          discordId: GUEST_ID,
          globalRole: 'guest',
          invitedBy: creator.id,
        }),
      ).rejects.toBeInstanceOf(ConflictError);

      const guest = await upsertDiscordUser(db(), {
        discordId: GUEST_ID,
        displayName: 'Guest',
        avatarHash: null,
      });
      await consumeInvite(db(), guest);
      const promoted = await findUserById(db(), guest.id);
      expect(promoted?.globalRole).toBe('helper');

      const access = await resolveLeagueAccess(
        db(),
        { userId: guest.id, discordId: GUEST_ID, tier: 'helper' },
        league.id,
      );
      expect(access?.access?.tier).toBe('helper');

      // Second consumption is a no-op.
      await consumeInvite(db(), promoted!);
    });
  });

  describe('sessions', () => {
    it('validates, revokes and expires sessions', async () => {
      const user = await upsertDiscordUser(db(), {
        discordId: GUEST_ID,
        displayName: 'S',
        avatarHash: null,
      });
      await createSession(db(), user.id, 'hash-1');
      expect(await findValidSession(db(), 'hash-1')).toMatchObject({ userId: user.id });

      await revokeSession(db(), 'hash-1');
      expect(await findValidSession(db(), 'hash-1')).toBeUndefined();

      await createSession(db(), user.id, 'hash-2');
      await db()
        .update(sessions)
        .set({ lastSeenAt: new Date(Date.now() - 13 * 60 * 60 * 1000) })
        .where(eq(sessions.tokenHash, 'hash-2'));
      expect(await findValidSession(db(), 'hash-2')).toBeUndefined();
    });
  });

  describe('leagues and access', () => {
    async function makeLeague(): Promise<string> {
      await ensureGuild(db(), GUILD_ID);
      const creator = await upsertDiscordUser(db(), {
        discordId: ROOT_ID,
        displayName: 'Root',
        avatarHash: null,
      });
      const league = await createLeague(db(), {
        guildId: GUILD_ID,
        citadelLeagueId: 7,
        name: 'HL',
        shortcode: 'HL7',
        createdByUserId: creator.id,
        createdByDiscordId: ROOT_ID,
      });
      return league.id;
    }

    it('creates the default hierarchy, creator membership and audit row', async () => {
      const leagueId = await makeLeague();
      const roles = await listLeagueRoles(db(), leagueId);
      expect(roles.map((role) => role.name)).toEqual([
        'Director',
        'Admin',
        'Trial',
        'Caster',
        'Player',
      ]);
      const audit = await listAudit(db());
      expect(audit.some((entry) => entry['action'] === 'league.create')).toBe(true);
    });

    it('rejects a duplicate Citadel league in the same guild', async () => {
      await makeLeague();
      const creator = await upsertDiscordUser(db(), {
        discordId: ROOT_ID,
        displayName: 'Root',
        avatarHash: null,
      });
      await expect(
        createLeague(db(), {
          guildId: GUILD_ID,
          citadelLeagueId: 7,
          name: 'Again',
          shortcode: 'AGN',
          createdByUserId: creator.id,
          createdByDiscordId: ROOT_ID,
        }),
      ).rejects.toThrow();
    });

    it('scopes league lists and capabilities by tier and membership', async () => {
      const leagueId = await makeLeague();
      await upsertDiscordUser(db(), {
        discordId: GUEST_ID,
        displayName: 'Guest',
        avatarHash: null,
      });

      const adminLeagues = await listLeaguesForActor(db(), {
        userId: '00000000-0000-0000-0000-000000000000',
        discordId: OTHER_ID,
        tier: 'admin',
      });
      expect(adminLeagues).toHaveLength(1);

      const outsider = await listLeaguesForActor(db(), {
        userId: '00000000-0000-0000-0000-000000000001',
        discordId: OTHER_ID,
        tier: 'guest',
      });
      expect(outsider).toHaveLength(0);

      const root = await findUserByDiscordId(db(), ROOT_ID);
      const director = await resolveLeagueAccess(
        db(),
        {
          userId: root!.id,
          discordId: ROOT_ID,
          tier: 'guest',
        },
        leagueId,
      );
      expect(director?.access?.capabilities.has('tournament.destructive')).toBe(true);

      const helper = await resolveLeagueAccess(
        db(),
        { userId: '00000000-0000-0000-0000-000000000002', discordId: OTHER_ID, tier: 'helper' },
        leagueId,
      );
      expect(helper?.access?.capabilities.has('tournament.destructive')).toBe(false);

      const noMembership = await resolveLeagueAccess(
        db(),
        { userId: '00000000-0000-0000-0000-000000000003', discordId: OTHER_ID, tier: 'guest' },
        leagueId,
      );
      expect(noMembership?.access).toBeNull();
    });
  });
});
