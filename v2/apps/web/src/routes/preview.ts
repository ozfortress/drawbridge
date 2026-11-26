/**
 * The preview API: a league is read from Citadel, turned into a deterministic
 * tournament plan and stored with the snapshot it was built from.
 *
 * Nothing here writes to Discord. A preview is what an admin looks at before
 * an approval binds to it, so the stored row keeps the plan, the hash over it
 * and the Citadel snapshot. The drift check recomputes the plan from live
 * Citadel data and compares it with the stored one, so an approval can never
 * be handed a plan that Citadel has moved away from.
 *
 * The Citadel key of a league is never returned: it is sealed with the master
 * key under the AAD `league_citadel_keys|{leagueId}|key_envelope`, which binds
 * the ciphertext to the row it belongs to.
 */
import { type CitadelClient, CitadelError, createCitadelClient } from '@drawbridge/citadel';
import { type Config, registerSecret } from '@drawbridge/config';
import { buildAad, Cipher } from '@drawbridge/crypto';
import {
  type Db,
  getLeagueCitadelKey,
  getPreview,
  guildDiscordObjectUsage,
  insertPreview,
  type LeagueRow,
  revokeLeagueCitadelKey,
  upsertLeagueCitadelKey,
} from '@drawbridge/db';
import {
  buildTournamentPlan,
  flagCapacityHeadroom,
  type LeagueSnapshot,
  type TournamentPlan,
} from '@drawbridge/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, useSecureCookies } from '../auth/session.js';
import { badRequest, HttpError, notFound } from '../http/errors.js';
import {
  audit,
  parseBody,
  requireLeagueCapability,
  requireLeagueCapabilityOn,
} from '../http/helpers.js';

/** How long a preview may be approved before it has to be built again. */
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

/** The AAD the Citadel key of a league is sealed under. */
function keyAad(leagueId: string): string {
  return buildAad('league_citadel_keys', leagueId, 'key_envelope');
}

const putKeyBody = z.object({
  key: z.string().min(8).max(500),
  label: z.string().max(100).optional(),
});

const previewParams = z.object({
  previewId: z.string().min(1),
});

/** The preview id of a route parameter. */
function previewIdOf(params: unknown): string {
  const parsed = previewParams.safeParse(params ?? {});
  if (!parsed.success) throw badRequest('previewId is required');
  return parsed.data.previewId;
}

/** Creates the Citadel client for one league key. Injected in tests. */
export interface CitadelClientInput {
  leagueId: string;
  baseUrl: string;
  apiKey: string;
}

export type CitadelClientFactory = (input: CitadelClientInput) => CitadelClient;

export function defaultCitadelFactory(input: CitadelClientInput): CitadelClient {
  return createCitadelClient({ baseUrl: input.baseUrl, apiKey: input.apiKey });
}

/** The parts of a stored plan the drift check compares. */
const storedPlanSchema = z.object({
  divisions: z.array(
    z.object({
      name: z.string(),
      entries: z.array(
        z.object({
          citadelRosterId: z.string(),
          citadelTeamId: z.string(),
          name: z.string(),
          roleName: z.string(),
          channelName: z.string(),
        }),
      ),
    }),
  ),
});

/** Maps a Citadel failure onto the status the API answers with. */
function citadelHttpError(error: unknown): HttpError {
  if (!(error instanceof CitadelError)) throw error;
  switch (error.code) {
    case 'citadel_not_visible':
      return new HttpError(
        422,
        'citadel_not_visible: the league is not visible to the stored Citadel key',
      );
    case 'fatal_config':
      return new HttpError(422, 'citadel_unauthorized: Citadel rejected the stored key');
    case 'object_missing':
      return new HttpError(404, 'citadel_object_missing: the Citadel object does not exist');
    case 'invalid_response':
      return new HttpError(502, 'citadel_invalid_response: Citadel sent an unreadable body');
    case 'transient':
      return new HttpError(503, 'citadel_unavailable: Citadel is not reachable right now');
  }
}

/** The master key cipher; without it no sealed key can be read or written. */
function cipherFor(config: Config): Cipher {
  if (!config.masterKey) {
    // A server misconfiguration, not a client error: it is logged, not answered.
    throw new Error('The master key is not configured, so keys cannot be sealed');
  }
  return Cipher.fromMasterKey(config.masterKey.reveal(), config.masterKeyId);
}

/**
 * Reads the league, its teams and its matches from Citadel.
 *
 * The league endpoint carries the rosters and the match list; the captains
 * live on the teams and the opponents of a match live on the match itself, so
 * both are read as well. The result is the snapshot the plan is built from.
 */
async function loadSnapshot(
  client: CitadelClient,
  citadelLeagueId: string,
): Promise<LeagueSnapshot> {
  const league = await client.getLeague(citadelLeagueId);

  const rosters = league.rosters.map((roster) => ({
    id: roster.id,
    team_id: roster.team_id,
    name: roster.name,
    division: roster.division,
  }));

  const teamIds = [...new Set(rosters.map((roster) => roster.team_id))].sort();
  const teams = [];
  for (const teamId of teamIds) {
    const team = await client.getTeam(teamId);
    teams.push({
      id: team.id,
      name: team.name,
      players: team.players.map((player) => ({
        id: player.id,
        name: player.name,
        is_captain: player.is_captain,
        discord_id: player.discord_id,
      })),
    });
  }

  const matches = [];
  for (const match of league.matches) {
    const full = await client.getMatch(match.id);
    matches.push({
      id: full.id,
      home: full.home_team.team_id,
      away: full.away_team ? full.away_team.team_id : null,
    });
  }

  return { id: league.id, name: league.name, rosters, teams, matches };
}

/** The parts of a plan the drift check compares. */
interface ComparablePlan {
  readonly divisions: readonly {
    readonly name: string;
    readonly entries: readonly {
      readonly citadelRosterId: string;
      readonly citadelTeamId: string;
      readonly name: string;
      readonly roleName: string;
      readonly channelName: string;
    }[];
  }[];
}

/**
 * The paths that differ between two plans.
 *
 * A path names the division and the entry it belongs to, so an admin sees
 * which team moved without reading the whole plan again.
 */
function changedPaths(before: ComparablePlan, after: ComparablePlan): string[] {
  const paths: string[] = [];
  const beforeDivisions = new Map(before.divisions.map((division) => [division.name, division]));
  const afterDivisions = new Map(after.divisions.map((division) => [division.name, division]));

  const divisionNames = [...new Set([...beforeDivisions.keys(), ...afterDivisions.keys()])].sort();
  for (const name of divisionNames) {
    const oldDivision = beforeDivisions.get(name);
    const newDivision = afterDivisions.get(name);
    if (!oldDivision || !newDivision) {
      paths.push(`divisions.${name}`);
      continue;
    }

    const oldEntries = new Map(oldDivision.entries.map((entry) => [entry.citadelRosterId, entry]));
    const newEntries = new Map(newDivision.entries.map((entry) => [entry.citadelRosterId, entry]));
    const rosterIds = [...new Set([...oldEntries.keys(), ...newEntries.keys()])].sort();
    for (const rosterId of rosterIds) {
      const oldEntry = oldEntries.get(rosterId);
      const newEntry = newEntries.get(rosterId);
      if (!oldEntry || !newEntry) {
        const entry = newEntry ?? oldEntry;
        paths.push(`divisions.${name}.entries.${entry!.name}`);
        continue;
      }
      if (oldEntry.name !== newEntry.name) {
        paths.push(`divisions.${name}.entries.${newEntry.name}.name`);
      }
      if (oldEntry.roleName !== newEntry.roleName) {
        paths.push(`divisions.${name}.entries.${newEntry.name}.roleName`);
      }
      if (oldEntry.channelName !== newEntry.channelName) {
        paths.push(`divisions.${name}.entries.${newEntry.name}.channelName`);
      }
      if (oldEntry.citadelTeamId !== newEntry.citadelTeamId) {
        paths.push(`divisions.${name}.entries.${newEntry.name}.citadelTeamId`);
      }
    }
  }

  return paths;
}

/** The sealed key of a league, opened with the master key. */
function openLeagueKey(config: Config, leagueId: string, envelope: string): string {
  return cipherFor(config).open(envelope, keyAad(leagueId));
}

/** The status the panel shows for a stored key. */
function keyStatus(row: { revokedAt: Date | null }): 'active' | 'revoked' {
  return row.revokedAt ? 'revoked' : 'active';
}

/** Everything a live plan build needs; shared by the preview and job routes. */
export interface PlanSource {
  db: Db;
  config: Config;
  /** Creates the Citadel client for a league key; injected so tests can use a fake. */
  citadel: CitadelClientFactory;
}

/**
 * Reads the league from Citadel and builds the plan from the live snapshot.
 * Citadel failures are mapped to their HTTP statuses here, so every caller
 * (preview, verify, an approval's drift check) answers them identically.
 */
export async function livePlanForLeague(
  source: PlanSource,
  league: LeagueRow,
): Promise<{ plan: TournamentPlan; snapshot: LeagueSnapshot }> {
  const stored = await getLeagueCitadelKey(source.db, league.id);
  if (!stored || stored.revokedAt) {
    throw new HttpError(409, 'citadel_key_missing: no Citadel key is stored for this league');
  }
  const apiKey = openLeagueKey(source.config, league.id, stored.keyEnvelope);
  const client = source.citadel({
    leagueId: league.id,
    baseUrl: source.config.citadelApiBaseUrl,
    apiKey,
  });
  let snapshot: LeagueSnapshot;
  try {
    snapshot = await loadSnapshot(client, String(league.citadelLeagueId));
  } catch (error) {
    throw citadelHttpError(error);
  }
  const plan = buildTournamentPlan(snapshot, { leagueShortcode: league.shortcode });
  return { plan, snapshot };
}

export interface PreviewRouteDeps {
  config: Config;
  db: Db;
  /** Creates the Citadel client for a league key; injected so tests can use a fake. */
  citadel?: CitadelClientFactory | undefined;
}

export function registerPreviewRoutes(app: FastifyInstance, deps: PreviewRouteDeps): void {
  const secure = useSecureCookies(deps.config.publicBaseUrl);
  const createCitadel = deps.citadel ?? defaultCitadelFactory;
  const source: PlanSource = { db: deps.db, config: deps.config, citadel: createCitadel };

  /** Reads the league from Citadel and builds the plan from the snapshot. */
  const planForLeague = (
    league: LeagueRow,
  ): Promise<{
    plan: TournamentPlan;
    snapshot: LeagueSnapshot;
  }> => livePlanForLeague(source, league);

  app.post('/api/v1/leagues/:leagueId/preview', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    const { leagueId } = await requireLeagueCapability(deps.db, request, auth, 'tournament.setup');
    const league = request.leagueContext!.league;

    const { plan, snapshot } = await planForLeague(league);

    // Capacity flagging (02 §4.8): the plan's own refusal says what the setup
    // cannot fit on its own; the headroom flags say what no longer fits
    // because the guild already holds recorded objects near a cap. Warnings,
    // not refusals — the ledger cannot see foreign objects, and the
    // executor's live preflight remains the authority that refuses a create.
    const usage = await guildDiscordObjectUsage(deps.db, league.guildId);
    const capacityHeadroom = flagCapacityHeadroom(
      {
        roleCount: plan.counts.roles,
        categories: plan.divisions.map((division) => ({
          name: division.categoryName,
          channelCount: division.entries.length,
        })),
      },
      usage,
    );

    const preview = await insertPreview(deps.db, {
      leagueId,
      createdByUserId: auth.userId,
      plan: plan as unknown as Record<string, unknown>,
      planHash: plan.planHash,
      snapshot: snapshot as unknown as Record<string, unknown>,
      citadelSnapshotAt: new Date(),
      expiresAt: new Date(Date.now() + PREVIEW_TTL_MS),
    });

    await audit(deps.db, request, auth, {
      action: 'preview.create',
      targetType: 'preview',
      targetId: preview.id,
      leagueId,
      after: { planHash: plan.planHash, counts: plan.counts },
    });

    return reply.status(201).send({
      previewId: preview.id,
      planHash: plan.planHash,
      plan,
      warnings: plan.warnings,
      capacity: plan.capacity,
      capacityHeadroom,
      guildUsage: usage,
      captains: plan.captainReport.captains,
    });
  });

  app.get('/api/v1/previews/:previewId', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    const previewId = previewIdOf(request.params);
    const preview = await getPreview(deps.db, previewId);
    if (!preview) throw notFound('Preview not found');
    await requireLeagueCapabilityOn(deps.db, auth, preview.leagueId, 'league.read');
    const consumedAt = preview.consumedAt?.toISOString() ?? null;
    if (preview.consumedAt) {
      throw new HttpError(409, 'This preview has already been consumed and cannot be reused');
    }
    const plan = preview.plan as Record<string, unknown>;
    return reply.send({
      previewId: preview.id,
      leagueId: preview.leagueId,
      planHash: preview.planHash,
      plan,
      warnings: plan['warnings'] ?? [],
      capacity: plan['capacity'] ?? null,
      captains: (plan['captainReport'] as { captains?: unknown } | undefined)?.captains ?? [],
      citadelSnapshotAt: preview.citadelSnapshotAt?.toISOString() ?? null,
      expiresAt: preview.expiresAt?.toISOString() ?? null,
      consumedAt,
      createdAt: preview.createdAt.toISOString(),
    });
  });

  app.post('/api/v1/previews/:previewId/verify', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    const previewId = previewIdOf(request.params);
    const preview = await getPreview(deps.db, previewId);
    if (!preview) throw notFound('Preview not found');
    const { league } = await requireLeagueCapabilityOn(
      deps.db,
      auth,
      preview.leagueId,
      'tournament.setup',
    );

    const stored = storedPlanSchema.safeParse(preview.plan);
    if (!stored.success) {
      throw new HttpError(409, 'preview_plan_corrupt: the stored preview plan cannot be read');
    }

    const { plan } = await planForLeague(league);
    const changed = plan.planHash !== preview.planHash;
    const paths = changed ? changedPaths(stored.data, plan) : [];

    await audit(deps.db, request, auth, {
      action: 'preview.verify',
      targetType: 'preview',
      targetId: preview.id,
      leagueId: preview.leagueId,
      after: { changed, changedPaths: paths },
    });

    return reply.send({
      previewId: preview.id,
      planHash: preview.planHash,
      livePlanHash: plan.planHash,
      changed,
      changedPaths: changed && paths.length === 0 ? ['plan'] : paths,
    });
  });

  app.get('/api/v1/leagues/:leagueId/citadel-key', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    const { leagueId } = await requireLeagueCapability(
      deps.db,
      request,
      auth,
      'citadel.keys.manage',
    );
    const stored = await getLeagueCitadelKey(deps.db, leagueId);
    if (!stored) {
      return reply.send({
        leagueId,
        configured: false,
        label: null,
        status: 'missing' as const,
        lastVerifiedAt: null,
      });
    }
    return reply.send({
      leagueId,
      configured: true,
      label: stored.label,
      status: keyStatus(stored),
      lastVerifiedAt: stored.lastVerifiedAt?.toISOString() ?? null,
      createdAt: stored.createdAt.toISOString(),
    });
  });

  app.put('/api/v1/leagues/:leagueId/citadel-key', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    const { leagueId } = await requireLeagueCapability(
      deps.db,
      request,
      auth,
      'citadel.keys.manage',
    );
    const league = request.leagueContext!.league;
    const body = parseBody(putKeyBody, request);
    registerSecret(body.key);

    // The key is verified against Citadel before it is stored, so a broken
    // key never reaches the database.
    const client = createCitadel({
      leagueId,
      baseUrl: deps.config.citadelApiBaseUrl,
      apiKey: body.key,
    });
    try {
      await client.getLeague(String(league.citadelLeagueId));
    } catch (error) {
      throw citadelHttpError(error);
    }

    const verifiedAt = new Date();
    await upsertLeagueCitadelKey(deps.db, {
      leagueId,
      keyEnvelope: cipherFor(deps.config).seal(body.key, keyAad(leagueId)),
      label: body.label ?? '',
      verifiedAt,
    });

    await audit(deps.db, request, auth, {
      action: 'citadel.key.set',
      targetType: 'league',
      targetId: leagueId,
      leagueId,
      after: { label: body.label ?? '' },
    });

    return reply.send({
      leagueId,
      configured: true,
      label: body.label ?? '',
      status: 'active' as const,
      lastVerifiedAt: verifiedAt.toISOString(),
    });
  });

  app.delete('/api/v1/leagues/:leagueId/citadel-key', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    const { leagueId } = await requireLeagueCapability(
      deps.db,
      request,
      auth,
      'citadel.keys.manage',
    );
    const stored = await getLeagueCitadelKey(deps.db, leagueId);
    await revokeLeagueCitadelKey(deps.db, leagueId);

    await audit(deps.db, request, auth, {
      action: 'citadel.key.revoke',
      targetType: 'league',
      targetId: leagueId,
      leagueId,
      after: { label: stored?.label ?? '' },
    });

    return reply.send({
      leagueId,
      configured: stored !== undefined,
      label: stored?.label ?? '',
      status: 'revoked' as const,
    });
  });
}
