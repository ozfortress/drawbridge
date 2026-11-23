/**
 * The deterministic tournament plan.
 *
 * The builder turns a Citadel snapshot into the exact list of writes a
 * tournament needs - the Discord categories, roles, channels, overwrites and
 * welcome messages plus the database rows that record them - together with
 * counts, warnings, a captain report and the capacity result. A hash over the
 * canonical form of that plan binds an approval to exactly this setup.
 *
 * The builder is pure: it never talks to Citadel or Discord, it never reads a
 * clock or a random source, and it keeps the snapshot itself out of the plan.
 * The same snapshot therefore always produces the same plan and the same hash.
 */

import {
  type AccessOverwrite,
  type ChannelKind,
  planAccess,
  type StaffRole,
  type TeamRole,
} from './access.js';
import { canonicalJson } from './canonical.js';
import { type CapacityPlan, planCapacity } from './capacity.js';
import { deriveLeague, type LeagueSnapshot, type LeagueSnapshotTeam } from './league.js';
import {
  DEFAULT_TEAM_NAME_BUDGET,
  divisionCategoryName,
  divisionRoleName,
  graphemeLength,
  teamChannelName,
  teamNameCollides,
  teamRoleName,
} from './naming.js';
import { sha256Hex } from './sha256.js';

/** The kind of write one step performs. */
export type PlanStepKind =
  | 'create-category'
  | 'create-role'
  | 'create-channel'
  | 'set-overwrites'
  | 'send-welcome-message'
  | 'insert-db-row';

/** A value written to the database as it is. */
export interface PlanLiteral {
  readonly kind: 'literal';
  readonly value: string | number | boolean | null;
}

/** A value taken from the result of an earlier step. */
export interface PlanReference {
  readonly kind: 'reference';
  readonly stepKey: string;
  readonly field: string;
}

/** One cell of a database row. */
export type PlanCell = PlanLiteral | PlanReference;

/** One column of a database row. */
export interface PlanColumn {
  readonly column: string;
  readonly cell: PlanCell;
}

/** Creates the Discord category of one division. */
export interface CreateCategoryStep {
  readonly kind: 'create-category';
  readonly key: string;
  readonly order: number;
  readonly division: string;
  readonly name: string;
}

/** Creates the division role or the role of one entry. */
export interface CreateRoleStep {
  readonly kind: 'create-role';
  readonly key: string;
  readonly order: number;
  readonly division: string;
  readonly scope: 'division' | 'entry';
  readonly name: string;
  readonly citadelRosterId: string | null;
}

/** Creates the team channel of one entry. */
export interface CreateChannelStep {
  readonly kind: 'create-channel';
  readonly key: string;
  readonly order: number;
  readonly division: string;
  readonly name: string;
  readonly citadelRosterId: string;
}

/** Sets the permission overwrites of one channel. */
export interface SetOverwritesStep {
  readonly kind: 'set-overwrites';
  readonly key: string;
  readonly order: number;
  readonly division: string;
  readonly channelKey: string;
  readonly channelName: string;
  readonly channelKind: ChannelKind;
  readonly overwrites: readonly AccessOverwrite[];
}

/** Sends the welcome message of one division. */
export interface WelcomeMessageStep {
  readonly kind: 'send-welcome-message';
  readonly key: string;
  readonly order: number;
  readonly division: string;
  readonly channelKey: string;
  readonly channelName: string;
  readonly content: string;
}

/** Inserts one database row. */
export interface InsertDbRowStep {
  readonly kind: 'insert-db-row';
  readonly key: string;
  readonly order: number;
  readonly division: string | null;
  readonly table: string;
  readonly values: readonly PlanColumn[];
}

/** One write of the plan. */
export type PlanStep =
  | CreateCategoryStep
  | CreateRoleStep
  | CreateChannelStep
  | SetOverwritesStep
  | WelcomeMessageStep
  | InsertDbRowStep;

/** One roster competing in a division. */
export interface PlanEntry {
  readonly citadelRosterId: string;
  readonly citadelTeamId: string;
  readonly name: string;
  readonly roleName: string;
  readonly channelName: string;
}

/** One division of the plan with the entries competing in it. */
export interface PlanDivision {
  readonly name: string;
  readonly categoryName: string;
  readonly roleName: string;
  readonly entries: readonly PlanEntry[];
}

/** Why the plan carries a warning. */
export type PlanWarningCode =
  | 'missing-roster'
  | 'missing-team'
  | 'no-captain'
  | 'name-truncated'
  | 'duplicate-name'
  | 'capacity-refusal'
  | 'capacity-split';

/** One warning about the snapshot the plan was built from. */
export interface PlanWarning {
  readonly code: PlanWarningCode;
  readonly subject: string;
  readonly message: string;
}

/** Whether a captain can be given the roles of the entry. */
export type CaptainStatus = 'will-assign' | 'not-linked';

/** One captain and the roles the plan would give them. */
export interface CaptainAssignment {
  readonly citadelTeamId: string;
  readonly citadelUserId: string;
  readonly name: string;
  readonly discordId: string | null;
  readonly division: string;
  readonly entryName: string;
  readonly status: CaptainStatus;
  readonly roleNames: readonly string[];
}

/** The captains of the league and what would happen to them. */
export interface CaptainReport {
  readonly total: number;
  readonly willAssign: number;
  readonly notLinked: number;
  readonly captains: readonly CaptainAssignment[];
}

/** How much the plan creates. */
export interface PlanCounts {
  readonly divisions: number;
  readonly entries: number;
  readonly categories: number;
  readonly roles: number;
  readonly channels: number;
  readonly steps: number;
}

/** The options of the plan builder. */
export interface TournamentPlanOptions {
  /** The shortcode appended to every created name. */
  readonly leagueShortcode: string;
  /** Staff roles that hold access purposes on the created channels. */
  readonly staffRoles?: readonly StaffRole[];
  /** The grapheme budget of a team name. Defaults to {@link DEFAULT_TEAM_NAME_BUDGET}. */
  readonly teamNameBudget?: number;
  /** The welcome message of a division category; `{division}` is the division name. */
  readonly welcomeTemplate?: string;
}

/** The plan the executor can act on, bound to its hash. */
export interface TournamentPlan {
  readonly leagueShortcode: string;
  readonly divisions: readonly PlanDivision[];
  readonly steps: readonly PlanStep[];
  readonly counts: PlanCounts;
  readonly warnings: readonly PlanWarning[];
  readonly captainReport: CaptainReport;
  readonly capacity: CapacityPlan;
  readonly planHash: string;
}

/** The welcome message of a division when the caller does not bring one. */
const DEFAULT_WELCOME_TEMPLATE =
  'Welcome to the {division} division. Your team channel is listed below. Good luck!';

/** Compares two strings by code unit, so the order never depends on the input. */
function compare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Sorts the warnings by code, subject and message. */
function sortWarnings(warnings: readonly PlanWarning[]): PlanWarning[] {
  return [...warnings].sort(
    (left, right) =>
      compare(left.code, right.code) ||
      compare(left.subject, right.subject) ||
      compare(left.message, right.message),
  );
}

/** Freezes the plan and everything inside it. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) {
    deepFreeze(entry);
  }
  return value;
}

/** The row that records a created role. The guild is filled in by the executor. */
function guildRoleRow(stepKey: string, name: string, division: string | null): InsertDbRowStep {
  return {
    kind: 'insert-db-row',
    key: `db:guild_roles:${stepKey}`,
    order: 0,
    division,
    table: 'guild_roles',
    values: [
      { column: 'discordRoleId', cell: { kind: 'reference', stepKey, field: 'discordId' } },
      { column: 'managed', cell: { kind: 'literal', value: true } },
      { column: 'name', cell: { kind: 'literal', value: name } },
    ],
  };
}

/** The row that records a created channel. The league is filled in by the executor. */
function managedChannelRow(
  stepKey: string,
  kind: 'division' | 'team',
  division: string | null,
): InsertDbRowStep {
  return {
    kind: 'insert-db-row',
    key: `db:managed_channels:${stepKey}`,
    order: 0,
    division,
    table: 'managed_channels',
    values: [
      { column: 'discordChannelId', cell: { kind: 'reference', stepKey, field: 'discordId' } },
      { column: 'kind', cell: { kind: 'literal', value: kind } },
    ],
  };
}

/**
 * Builds the tournament plan of a Citadel snapshot.
 *
 * The plan holds the steps that create the league (category, roles, team
 * channels, overwrites, welcome messages and the database rows that record
 * them), the counts of what it creates, the warnings about the snapshot, the
 * captain report and the capacity result.
 *
 * Every array is sorted canonically - divisions by name, entries by name and
 * roster id, the steps by the order in which they run - so the plan of two
 * equal snapshots is byte for byte the same. `planHash` is the SHA-256 of the
 * canonical JSON of the plan without the hash itself, which makes the hash a
 * fingerprint of the setup and nothing else: no timestamp, no random id and
 * no snapshot metadata take part in it.
 *
 * No roster is ever dropped silently: a roster that is missing from the
 * snapshot but still referenced by a match produces a warning.
 */
export function buildTournamentPlan(
  snapshot: LeagueSnapshot,
  options: TournamentPlanOptions,
): TournamentPlan {
  const shortcode = options.leagueShortcode;
  const budget = options.teamNameBudget ?? DEFAULT_TEAM_NAME_BUDGET;
  const staffRoles = [...(options.staffRoles ?? [])].sort((left, right) =>
    compare(left.id, right.id),
  );
  const template = options.welcomeTemplate ?? DEFAULT_WELCOME_TEMPLATE;

  const structure = deriveLeague(snapshot);
  const divisions = [...structure.divisions].sort((left, right) => compare(left.name, right.name));

  const teamsById = new Map<string, LeagueSnapshotTeam>();
  for (const team of snapshot.teams) {
    teamsById.set(team.id, team);
  }

  const rosterTeamIds = new Set<string>();
  for (const roster of snapshot.rosters) {
    rosterTeamIds.add(roster.team_id);
  }

  const warnings: PlanWarning[] = [];
  const planDivisions: PlanDivision[] = [];
  const roleSteps: CreateRoleStep[] = [];
  const categorySteps: CreateCategoryStep[] = [];
  const channelSteps: CreateChannelStep[] = [];
  const overwriteSteps: SetOverwritesStep[] = [];
  const welcomeSteps: WelcomeMessageStep[] = [];
  const dbSteps: InsertDbRowStep[] = [];
  const captainAssignments: CaptainAssignment[] = [];

  for (const division of divisions) {
    const entries = [...division.entries].sort(
      (left, right) =>
        compare(left.name, right.name) || compare(left.citadelRosterId, right.citadelRosterId),
    );

    const categoryName = divisionCategoryName(division.name, shortcode);
    const roleName = divisionRoleName(division.name, shortcode);
    const categoryKey = `category:${division.name}`;

    categorySteps.push({
      kind: 'create-category',
      key: categoryKey,
      order: 0,
      division: division.name,
      name: categoryName,
    });
    roleSteps.push({
      kind: 'create-role',
      key: `role:division:${division.name}`,
      order: 0,
      division: division.name,
      scope: 'division',
      name: roleName,
      citadelRosterId: null,
    });
    dbSteps.push(guildRoleRow(`role:division:${division.name}`, roleName, division.name));
    dbSteps.push(managedChannelRow(categoryKey, 'division', division.name));

    overwriteSteps.push({
      kind: 'set-overwrites',
      key: `overwrites:${categoryKey}`,
      order: 0,
      division: division.name,
      channelKey: categoryKey,
      channelName: categoryName,
      channelKind: 'category',
      overwrites: planAccess({ kind: 'category', staffRoles }).overwrites,
    });

    welcomeSteps.push({
      kind: 'send-welcome-message',
      key: `welcome:${categoryKey}`,
      order: 0,
      division: division.name,
      channelKey: categoryKey,
      channelName: categoryName,
      content: template.replaceAll('{division}', division.name),
    });

    const planEntries: PlanEntry[] = [];

    for (const entry of entries) {
      const siblingNames = entries
        .filter((other) => other.citadelRosterId !== entry.citadelRosterId)
        .map((other) => other.name);
      const entryRoleKey = `role:entry:${entry.citadelRosterId}`;
      const entryChannelKey = `channel:entry:${entry.citadelRosterId}`;
      const entryRoleName = teamRoleName(entry.name, shortcode, {
        budget,
        rosterId: entry.citadelRosterId,
        siblingNames,
      });
      const entryChannelName = teamChannelName(entry.name, shortcode, {
        budget,
        rosterId: entry.citadelRosterId,
        siblingNames,
      });

      roleSteps.push({
        kind: 'create-role',
        key: entryRoleKey,
        order: 0,
        division: division.name,
        scope: 'entry',
        name: entryRoleName,
        citadelRosterId: entry.citadelRosterId,
      });
      channelSteps.push({
        kind: 'create-channel',
        key: entryChannelKey,
        order: 0,
        division: division.name,
        name: entryChannelName,
        citadelRosterId: entry.citadelRosterId,
      });
      dbSteps.push(guildRoleRow(entryRoleKey, entryRoleName, division.name));
      dbSteps.push(managedChannelRow(entryChannelKey, 'team', division.name));

      const teamRole: TeamRole = { id: entryRoleKey, name: entryRoleName };
      overwriteSteps.push({
        kind: 'set-overwrites',
        key: `overwrites:${entryChannelKey}`,
        order: 0,
        division: division.name,
        channelKey: entryChannelKey,
        channelName: entryChannelName,
        channelKind: 'team',
        overwrites: planAccess({ kind: 'team', teamRoles: [teamRole], staffRoles }).overwrites,
      });

      if (graphemeLength(entry.name.trim()) > budget) {
        warnings.push({
          code: 'name-truncated',
          subject: entry.citadelRosterId,
          message: `The name of entry "${entry.name}" is longer than the budget of ${budget} characters and was trimmed.`,
        });
      }
      if (teamNameCollides(entry.name, siblingNames, budget)) {
        warnings.push({
          code: 'duplicate-name',
          subject: entry.citadelRosterId,
          message: `The name of entry "${entry.name}" collides with another entry of division "${division.name}"; the roster id was added to its role and channel names.`,
        });
      }

      const team = teamsById.get(entry.citadelTeamId);
      if (!team) {
        warnings.push({
          code: 'missing-team',
          subject: entry.citadelRosterId,
          message: `Roster "${entry.citadelRosterId}" references team "${entry.citadelTeamId}", which is missing from the snapshot.`,
        });
      } else {
        const captains = team.players
          .filter((player) => player.is_captain)
          .sort((left, right) => compare(left.id, right.id));
        if (captains.length === 0) {
          warnings.push({
            code: 'no-captain',
            subject: entry.citadelRosterId,
            message: `Entry "${entry.name}" has no captain in the snapshot.`,
          });
        }
        for (const captain of captains) {
          captainAssignments.push({
            citadelTeamId: team.id,
            citadelUserId: captain.id,
            name: captain.name,
            discordId: captain.discord_id ?? null,
            division: division.name,
            entryName: entry.name,
            status: captain.discord_id ? 'will-assign' : 'not-linked',
            roleNames: [roleName, entryRoleName],
          });
        }
      }

      planEntries.push({
        citadelRosterId: entry.citadelRosterId,
        citadelTeamId: entry.citadelTeamId,
        name: entry.name,
        roleName: entryRoleName,
        channelName: entryChannelName,
      });
    }

    planDivisions.push({
      name: division.name,
      categoryName,
      roleName,
      entries: planEntries,
    });
  }

  // A match against a team that has no roster means the snapshot lost an entry.
  const matchesByTeam = new Map<string, string[]>();
  for (const match of snapshot.matches) {
    for (const teamId of [match.home, match.away]) {
      if (teamId === null || teamId === undefined) continue;
      if (rosterTeamIds.has(teamId)) continue;
      const matchIds = matchesByTeam.get(teamId) ?? [];
      matchIds.push(match.id);
      matchesByTeam.set(teamId, matchIds);
    }
  }
  for (const [teamId, matchIds] of [...matchesByTeam.entries()].sort((left, right) =>
    compare(left[0], right[0]),
  )) {
    const sortedMatchIds = [...new Set(matchIds)].sort(compare);
    warnings.push({
      code: 'missing-roster',
      subject: teamId,
      message: `Team "${teamId}" is referenced by ${
        sortedMatchIds.length === 1 ? 'match' : 'matches'
      } ${sortedMatchIds.map((id) => `"${id}"`).join(', ')} but has no roster in the snapshot.`,
    });
  }

  const capacity = planCapacity({
    roleCount: roleSteps.length,
    categories: divisions.map((division) => ({
      name: divisionCategoryName(division.name, shortcode),
      channelCount: division.entries.length,
    })),
  });

  for (const refusal of capacity.refusals) {
    warnings.push({
      code: 'capacity-refusal',
      subject: refusal.scope,
      message: refusal.message,
    });
  }
  for (const split of capacity.splits) {
    warnings.push({
      code: 'capacity-split',
      subject: split.name,
      message: `Division "${split.name}" holds more channels than a category may hold and was split into ${split.parts.length} categories.`,
    });
  }

  overwriteSteps.sort(
    (left, right) =>
      compare(left.division, right.division) || compare(left.channelKey, right.channelKey),
  );
  dbSteps.sort((left, right) => compare(left.table, right.table) || compare(left.key, right.key));

  const steps: PlanStep[] = [];
  let order = 0;
  const nextOrder = (): number => {
    order += 1;
    return order;
  };
  for (const step of roleSteps) steps.push({ ...step, order: nextOrder() });
  for (const step of categorySteps) steps.push({ ...step, order: nextOrder() });
  for (const step of channelSteps) steps.push({ ...step, order: nextOrder() });
  for (const step of overwriteSteps) steps.push({ ...step, order: nextOrder() });
  for (const step of welcomeSteps) steps.push({ ...step, order: nextOrder() });
  for (const step of dbSteps) steps.push({ ...step, order: nextOrder() });

  const counts: PlanCounts = {
    divisions: planDivisions.length,
    entries: planDivisions.reduce((sum, division) => sum + division.entries.length, 0),
    categories: categorySteps.length,
    roles: roleSteps.length,
    channels: channelSteps.length,
    steps: steps.length,
  };

  const captainReport: CaptainReport = {
    total: captainAssignments.length,
    willAssign: captainAssignments.filter((captain) => captain.status === 'will-assign').length,
    notLinked: captainAssignments.filter((captain) => captain.status === 'not-linked').length,
    captains: captainAssignments,
  };

  const content = {
    leagueShortcode: shortcode,
    divisions: planDivisions,
    steps,
    counts,
    warnings: sortWarnings(warnings),
    captainReport,
    capacity,
  };

  return deepFreeze({ ...content, planHash: sha256Hex(canonicalJson(content)) });
}
