/**
 * Operator decisions on a job (plan 02 §5.8): retry, skip, adopt, revert
 * and abort, each gated by the `jobs.decide` capability.
 *
 * The five decisions answer an `awaiting_decision` prompt; `revert` and
 * `abort` additionally work as operator actions on an active job (the
 * machine's `revert`/`cancel` edges out of `running|paused`, which todo 15
 * built for exactly this). An unauthorized or invalid decision throws
 * before anything is written: the transaction rolls back and the job is
 * byte-for-byte unchanged.
 *
 * A decision that moves the job to `running` hands it back to the worker
 * pool as a running job with an at-`now()`-expired lease: the first worker
 * whose `reclaimExpired` scan runs takes it over with a fresh lease. That
 * is the only route back into execution the existing machinery offers
 * (the claim scan covers `queued|paused` only), and it needs no new state
 * or edge. A revert hands the job to the revert loop by leaving it
 * `reverting` with no lease, claimable by `claimRevertNext`. Abort cancels
 * the job and leaves every object exactly as it is (02 §5.8).
 */
import type { Capability } from '@drawbridge/authz';
import {
  appendJobEvent,
  type Db,
  type DbTx,
  type JobRow,
  type JobStepRow,
  jobSteps,
  jobs,
  updateJobState,
  upsertDiscordObject,
} from '@drawbridge/db';
import { and, eq, sql } from 'drizzle-orm';
import { lockJobRow } from './engine.js';
import { type ExternalId, ledgerOwner } from './reconcile.js';
import { revertRequiresDestructive } from './revert.js';
import {
  type JobEvent,
  type JobPauseReason,
  type JobSnapshot,
  type JobState,
  type TransitionContext,
  type TransitionResult,
  transition,
} from './state.js';

/** The capability every decision requires (02 §5.8). */
export const DECISION_CAPABILITY: Capability = 'jobs.decide';

/** The capability a revert additionally requires when it deletes anything (02 §5.8). */
export const DESTRUCTIVE_CAPABILITY: Capability = 'tournament.destructive';

/**
 * Thrown when the actor lacks a capability the decision needs. Nothing
 * was written; the job is unchanged.
 */
export class UnauthorizedDecision extends Error {
  override readonly name = 'UnauthorizedDecision';
  /** The capabilities the actor did not hold. */
  readonly missing: readonly Capability[];

  constructor(missing: readonly Capability[]) {
    super(`decision refused: requires ${missing.join(', ')}`);
    this.missing = missing;
  }
}

/** Thrown when a decision is legal to make but this job cannot take it. */
export class InvalidDecision extends Error {
  override readonly name = 'InvalidDecision';
}

/** Who decides: the acting user and their effective capabilities. */
export interface DecisionActor {
  userId: string;
  /** Effective capabilities, as packages/authz `mergeCapabilities` computes. */
  capabilities: ReadonlySet<Capability>;
}

/** One of the five decisions (02 §5.8). */
export type JobDecision =
  | { type: 'retry' }
  | { type: 'skip'; stepSeq: number }
  | { type: 'adopt'; stepSeq: number; object?: ExternalId }
  | { type: 'revert' }
  | { type: 'abort' };

const STEP_FINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'skipped', 'compensated']);

function snapshot(job: JobRow): JobSnapshot {
  return {
    state: job.state as JobState,
    pauseReason: job.pauseReason as JobPauseReason | null,
  };
}

/** The machine event a decision maps to, from the job's current state. */
function decisionEvent(job: JobRow, decision: JobDecision): JobEvent {
  switch (decision.type) {
    case 'retry':
      return { type: 'decide_retry' };
    case 'skip':
      return { type: 'decide_skip', stepSeq: decision.stepSeq };
    case 'adopt':
      return { type: 'decide_adopt' };
    case 'revert':
      // An awaiting_decision prompt answers decide_revert; an operator
      // undoing a live job takes the machine's revert edge instead.
      return job.state === 'awaiting_decision' ? { type: 'decide_revert' } : { type: 'revert' };
    case 'abort':
      return job.state === 'awaiting_decision' ? { type: 'decide_abort' } : { type: 'cancel' };
  }
  return decision satisfies never;
}

function decisionDetail(actor: DecisionActor): TransitionContext {
  return { detail: `by user ${actor.userId}` };
}

/** Applies one machine move inside the caller's transaction. */
async function applyMove(
  tx: DbTx,
  job: JobRow,
  event: JobEvent,
  ctx: TransitionContext,
): Promise<TransitionResult> {
  const result = transition(snapshot(job), event, ctx);
  const draft = result.events[0];
  if (!draft) throw new Error('state machine produced no event row');
  await appendJobEvent(tx, job.id, draft);
  return result;
}

/** The step a decision names, or an InvalidDecision naming the problem. */
async function findDecisionStep(tx: DbTx, jobId: string, stepSeq: number): Promise<JobStepRow> {
  const rows = await tx
    .select()
    .from(jobSteps)
    .where(and(eq(jobSteps.jobId, jobId), eq(jobSteps.seq, stepSeq)))
    .limit(1);
  const step = rows[0];
  if (!step) throw new InvalidDecision(`step ${stepSeq} does not exist on job ${jobId}`);
  return step;
}

/**
 * Applies one of the five decisions (02 §5.8). The transaction serialises
 * on the job row, so two racing decisions resolve one after the other and
 * the second hits the machine's edge table for the state the first left.
 *
 * Guards, all refusing without any state change:
 *  - the actor must hold `jobs.decide` (UnauthorizedDecision otherwise);
 *  - a revert whose done steps carry deleting compensations additionally
 *    requires `tournament.destructive`;
 *  - a skip needs a step that exists, is marked skippable and is not
 *    already finished (InvalidDecision otherwise);
 *  - the machine itself rejects a decision that does not fit the job's
 *    state (InvalidTransition).
 */
export async function applyDecision(
  db: Db,
  jobId: string,
  decision: JobDecision,
  actor: DecisionActor,
): Promise<JobRow> {
  return db.transaction(async (tx) => {
    const job = await lockJobRow(tx, jobId);
    const steps = await tx
      .select()
      .from(jobSteps)
      .where(eq(jobSteps.jobId, jobId))
      .orderBy(jobSteps.seq);

    // Capability gate first: an unauthorized caller learns nothing else.
    const missing: Capability[] = [];
    if (!actor.capabilities.has(DECISION_CAPABILITY)) missing.push(DECISION_CAPABILITY);
    if (decision.type === 'revert' && revertRequiresDestructive(steps)) {
      if (!actor.capabilities.has(DESTRUCTIVE_CAPABILITY)) missing.push(DESTRUCTIVE_CAPABILITY);
    }
    if (missing.length > 0) throw new UnauthorizedDecision(missing);

    // Step guards before the machine move, so a bad step is refused even
    // when the state would have allowed the transition.
    if (decision.type === 'skip') {
      const step = await findDecisionStep(tx, jobId, decision.stepSeq);
      if (!step.skippable) {
        throw new InvalidDecision(`step ${decision.stepSeq} is not skippable`);
      }
      if (STEP_FINAL_STATUSES.has(step.status)) {
        throw new InvalidDecision(`step ${decision.stepSeq} is already ${step.status}`);
      }
    }
    if (decision.type === 'adopt') {
      await findDecisionStep(tx, jobId, decision.stepSeq);
    }

    // The machine move: throws InvalidTransition for a decision that does
    // not fit the job's state, before anything is written.
    const event = decisionEvent(job, decision);
    const result = await applyMove(tx, job, event, decisionDetail(actor));

    if (decision.type === 'skip') {
      const step = await findDecisionStep(tx, jobId, decision.stepSeq);
      // The skip is recorded in the journal (the machine row above) and on
      // the step itself (02 §5.8).
      await tx
        .update(jobSteps)
        .set({ status: 'skipped', finishedAt: sql`now()` })
        .where(eq(jobSteps.id, step.id));
    }

    if (decision.type === 'adopt' && decision.object !== undefined) {
      const step = await findDecisionStep(tx, jobId, decision.stepSeq);
      const adopted = decision.object;
      const recorded = step.externalIds as unknown as ExternalId[];
      const known = recorded.some((entry) => entry.discordId === adopted.discordId);
      if (!known) {
        // Adoption records the object on the step and in the ledger, then
        // completes the step: the object exists and is ours, so a re-run
        // must not create a second one (02 §5.4, §5.6).
        const entry: ExternalId = adopted;
        await tx
          .update(jobSteps)
          .set({
            status: 'done',
            externalIds: [...recorded, entry] as unknown as typeof step.externalIds,
            finishedAt: sql`now()`,
          })
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
      }
    }

    const decided: Record<string, unknown> = {
      type: decision.type,
      actorUserId: actor.userId,
      at: new Date().toISOString(),
    };

    if (result.state === 'running') {
      // Hand the job back to the worker pool as a due-expired running job:
      // the first reclaiming worker takes it over (02 §5.5).
      const rows = await tx
        .update(jobs)
        .set({
          state: result.state,
          pauseReason: result.pauseReason,
          leaseOwner: null,
          leaseExpiresAt: sql`now()`,
          decision: decided,
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, jobId))
        .returning();
      return requireRow(rows, 'decision update');
    }

    if (result.state === 'reverting') {
      // The revert loop claims reverting jobs with no lease
      // (claimRevertNext); make it due right away.
      return updateJobState(tx, jobId, {
        state: result.state,
        pauseReason: result.pauseReason,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextRunAt: new Date(),
        decision: decided,
      });
    }

    // cancelled (abort): leave every object exactly as it is.
    return updateJobState(tx, jobId, {
      state: result.state,
      pauseReason: result.pauseReason,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: new Date(),
      decision: decided,
    });
  });
}

function requireRow<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}
