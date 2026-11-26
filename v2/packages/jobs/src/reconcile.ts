/**
 * Reconciliation of a step that was running when its worker died
 * (plan 02 §5.6, audit reason tags 02 §4.16).
 *
 * Every Discord and audit-log access goes through the injected
 * {@link ReconcilePort}: tests fake the port, the worker wires the real
 * Discord adapter to it. The logic below only touches the database, inside
 * the reclaim transaction, before the lease moves to the new owner.
 */
import {
  type DbTx,
  type DiscordObjectKind,
  discordObjects,
  type JobRow,
  type JobStepRow,
  jobSteps,
  upsertDiscordObject,
} from '@drawbridge/db';
import { and, eq } from 'drizzle-orm';

/** The reason tag every Discord write carries; reconciliation searches by it. */
export function auditReasonTag(jobId: string, seq: number): string {
  return `drb:${jobId}:${seq}`;
}

/**
 * What a step records in `external_ids` for every object it creates, before
 * it is marked done (02 §5.4). Reconciliation trusts this shape: the rows are
 * written by our own step executor in the same transaction as the ledger row.
 */
export interface ExternalId {
  discordId: string;
  kind: DiscordObjectKind;
  name: string;
}

/** A Discord create the audit log attributes to one of our reason tags. */
export interface AuditEntry {
  discordId: string;
  name: string;
  kind: DiscordObjectKind;
}

/**
 * Read-only Discord access reconciliation needs. Implemented by the worker
 * over the real Discord REST client; faked in tests.
 */
export interface ReconcilePort {
  /** One managed object with its live name, or undefined when it is gone. */
  fetchObject(guildId: string, discordId: string): Promise<{ name: string } | undefined>;
  /** Audit-log entries whose reason carries the given tag. */
  searchAuditByReason(guildId: string, reason: string): Promise<readonly AuditEntry[]>;
}

/**
 * What reconciliation concluded for the running step. `awaiting_decision`
 * parks the job for an operator (02 §5.8); `adopted` and `re_run` both let
 * the job continue under the new owner.
 */
export type ReconcileOutcome =
  | { kind: 'awaiting_decision'; detail: string }
  | { kind: 'adopted'; entry: ExternalId }
  | { kind: 're_run'; detail: string };

/**
 * Discord slugifies text-channel names (lowercase, hyphen-separated) while
 * other object names keep their case (02 §4.10). Verification compares
 * normalised forms, so a channel created as "Division X" matches
 * "division-x". The exact slug rules are verified at build time.
 */
export function normalizeDiscordName(kind: string, name: string): string {
  if (kind === 'text_channel') {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
  return name.trim();
}

/** The ledger owner a job's created objects belong to. */
export function ledgerOwner(job: JobRow): { ownerType: 'guild' | 'league'; ownerId: string } {
  return job.leagueId
    ? { ownerType: 'league', ownerId: job.leagueId }
    : { ownerType: 'guild', ownerId: job.guildId };
}

/**
 * Reconciles the step that was running when a lease expired, applying the
 * database effects 02 §5.6 prescribes and returning the outcome for the
 * caller to apply to the job itself:
 *
 * - recorded external ids are verified to exist and match their expected
 *   name; a missing object marks the ledger row `missing` and asks for a
 *   decision, a renamed one asks for a decision without touching the ledger;
 * - with no recorded ids, the audit log is searched by the step's reason
 *   tag; a match is adopted onto the step and into the ledger;
 * - with no trace at all the step re-runs. Create steps check by name
 *   first, so a re-run cannot create a second object with the same name.
 */
export async function reconcileRunningStep(
  tx: DbTx,
  port: ReconcilePort,
  job: JobRow,
  step: JobStepRow,
): Promise<ReconcileOutcome> {
  // Written by our step executor in the same transaction as the ledger row
  // (02 §5.4), so the shape is trusted; the column is untyped jsonb.
  const recorded = step.externalIds as unknown as ExternalId[];

  if (recorded.length > 0) {
    for (const entry of recorded) {
      const found = await port.fetchObject(job.guildId, entry.discordId);
      if (found === undefined) {
        // The ledger row exists (same transaction as external_ids, 02 §5.4);
        // mark only its state, keeping the original provenance untouched.
        await tx
          .update(discordObjects)
          .set({ state: 'missing' })
          .where(
            and(
              eq(discordObjects.guildId, job.guildId),
              eq(discordObjects.discordId, entry.discordId),
            ),
          );
        return {
          kind: 'awaiting_decision',
          detail: `${entry.kind} '${entry.name}' (${entry.discordId}) is missing from Discord`,
        };
      }
      if (
        normalizeDiscordName(entry.kind, found.name) !==
        normalizeDiscordName(entry.kind, entry.name)
      ) {
        return {
          kind: 'awaiting_decision',
          detail: `${entry.kind} '${entry.name}' (${entry.discordId}) is now named '${found.name}'`,
        };
      }
    }
    return {
      kind: 're_run',
      detail: 'recorded external ids verified; the step re-runs and completes by name',
    };
  }

  const hits = await port.searchAuditByReason(job.guildId, auditReasonTag(job.id, step.seq));
  const hit = hits[0];
  if (!hit) {
    return {
      kind: 're_run',
      detail: `no audit entry for ${auditReasonTag(job.id, step.seq)}; the step re-runs`,
    };
  }

  const entry: ExternalId = { discordId: hit.discordId, kind: hit.kind, name: hit.name };
  await tx
    .update(jobSteps)
    .set({ externalIds: [...recorded, entry] as unknown as typeof step.externalIds })
    .where(eq(jobSteps.id, step.id));
  const owner = ledgerOwner(job);
  await upsertDiscordObject(tx, {
    guildId: job.guildId,
    discordId: entry.discordId,
    kind: entry.kind,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    createdByJobId: job.id,
  });
  return { kind: 'adopted', entry };
}
