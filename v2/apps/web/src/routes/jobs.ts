/**
 * The job API (plan 02 §5.2, §5.8, §11).
 *
 * Approval turns a preview into a job: the stored plan hash is re-verified
 * against the live Citadel snapshot so an approval can never bind to a plan
 * that has moved on (409 `plan_changed`, nothing created), the preview is
 * consumed in the same transaction that creates the job, and the duplicate
 * guard (02 §5.10) arbitrates a second active job with the same plan hash.
 * Approval is idempotent (02 §5.2): the preview records the job it
 * produced, so a repeated call returns that job instead of a second one -
 * including when two approvals race and the loser's insert bounces off the
 * guard.
 *
 * Listing and reading jobs is league-scoped (`league.read`); guild-scoped
 * jobs are not exposed through this API. Decisions (retry, skip, adopt,
 * revert, abort) and cancel run through the todo-17 engine, which gates on
 * `jobs.decide` - and, for a revert whose compensations delete anything, on
 * `tournament.destructive` - before touching the job. Every decision is
 * audited.
 */
import type { Config } from '@drawbridge/config';
import {
  ConflictError,
  type CreateJobStepInput,
  consumePreviewForJob,
  createJob,
  type Db,
  getJob,
  getPreview,
  type JobEventRow,
  type JobRow,
  type JobStepRow,
  listJobsByLeague,
  NotFoundError,
} from '@drawbridge/db';
import type { TournamentPlan } from '@drawbridge/domain';
import {
  applyDecision,
  type DecisionActor,
  InvalidDecision,
  InvalidTransition,
  JOB_STATES,
  type JobDecision,
  UnauthorizedDecision,
} from '@drawbridge/jobs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type AuthContext, requireAuth, useSecureCookies } from '../auth/session.js';
import { badRequest, forbidden, HttpError, notFound } from '../http/errors.js';
import {
  audit,
  parseBody,
  parseQuery,
  requireLeagueAccess,
  requireLeagueCapability,
  requireLeagueCapabilityOn,
} from '../http/helpers.js';
import {
  type CitadelClientFactory,
  defaultCitadelFactory,
  livePlanForLeague,
  type PlanSource,
} from './preview.js';

const jobParams = z.object({
  jobId: z.string().min(1),
});

/** The job id of a route parameter. */
function jobIdOf(params: unknown): string {
  const parsed = jobParams.safeParse(params ?? {});
  if (!parsed.success) throw badRequest('jobId is required');
  return parsed.data.jobId;
}

const approveBody = z.object({
  previewId: z.string().min(1),
});

const listQuery = z.object({
  state: z.enum(JOB_STATES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const decisionBody = z
  .object({
    type: z.enum(['retry', 'skip', 'adopt', 'revert', 'abort']),
    stepSeq: z.number().int().min(0).optional(),
    object: z
      .object({
        discordId: z.string().min(1),
        kind: z.enum(['role', 'category', 'text_channel', 'message', 'webhook', 'other']),
        name: z.string().min(1),
      })
      .optional(),
  })
  .refine(
    (body) =>
      body.type === 'retry' ||
      body.type === 'revert' ||
      body.type === 'abort' ||
      body.stepSeq !== undefined,
    { message: 'stepSeq is required for skip and adopt', path: ['stepSeq'] },
  );

type DecisionBody = z.infer<typeof decisionBody>;

/** The five decisions, built from a validated request body (02 §5.8). */
function decisionOf(body: DecisionBody): JobDecision {
  switch (body.type) {
    case 'retry':
      return { type: 'retry' };
    case 'skip': {
      if (body.stepSeq === undefined) throw badRequest('stepSeq is required for skip');
      return { type: 'skip', stepSeq: body.stepSeq };
    }
    case 'adopt': {
      if (body.stepSeq === undefined) throw badRequest('stepSeq is required for adopt');
      return {
        type: 'adopt',
        stepSeq: body.stepSeq,
        ...(body.object ? { object: body.object } : {}),
      };
    }
    case 'revert':
      return { type: 'revert' };
    case 'abort':
      return { type: 'abort' };
  }
}

/** The preview was consumed by a racing approval after this one's open check. */
class PreviewRaced extends Error {
  override readonly name = 'PreviewRaced';
}

/**
 * Maps the plan's own step list onto job step rows (02 §5.2, §5.4). The step
 * kind is the plan step's kind; everything else the step carries rides along
 * as its args. The welcome message is the plan's one announcement write: a
 * revert neither deletes nor unpins it, so it is the one non-reversible kind.
 */
function planStepInputs(plan: TournamentPlan): CreateJobStepInput[] {
  return plan.steps.map((step) => {
    const args = { ...step } as Record<string, unknown>;
    delete args['kind'];
    return {
      seq: step.order,
      kind: step.kind,
      args,
      skippable: false,
      reversible: step.kind !== 'send-welcome-message',
      compensation: null,
    };
  });
}

function serialiseJob(job: JobRow): Record<string, unknown> {
  return {
    id: job.id,
    type: job.type,
    guildId: job.guildId,
    leagueId: job.leagueId,
    lane: job.lane,
    state: job.state,
    pauseReason: job.pauseReason,
    priority: job.priority,
    planHash: job.planHash,
    attempt: job.attempt,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    nextRunAt: job.nextRunAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

function serialiseStep(step: JobStepRow): Record<string, unknown> {
  return {
    seq: step.seq,
    kind: step.kind,
    status: step.status,
    attempts: step.attempts,
    skippable: step.skippable,
    reversible: step.reversible,
    externalIds: step.externalIds,
    result: step.result,
    error: step.error,
    startedAt: step.startedAt?.toISOString() ?? null,
    finishedAt: step.finishedAt?.toISOString() ?? null,
  };
}

/** One journal line; the plain-language job log the panel shows (02 §5.13). */
function serialiseEvent(event: JobEventRow): Record<string, unknown> {
  return {
    id: event.id,
    at: event.at.toISOString(),
    level: event.level,
    code: event.code,
    message: event.message,
    data: event.data,
  };
}

/** Applies one decision, mapping the engine's refusals onto the API's answers. */
async function applyDecisionOrHttpError(
  db: Db,
  jobId: string,
  decision: JobDecision,
  actor: DecisionActor,
): Promise<JobRow> {
  try {
    return await applyDecision(db, jobId, decision, actor);
  } catch (error) {
    if (error instanceof UnauthorizedDecision) throw forbidden(error.message);
    if (error instanceof InvalidDecision) throw badRequest(error.message);
    if (error instanceof InvalidTransition) throw new HttpError(409, error.message);
    if (error instanceof NotFoundError) throw notFound('Job not found');
    throw error;
  }
}

/** Loads one league-scoped job and the actor who may decide on it. */
async function loadDecisionJob(
  db: Db,
  auth: AuthContext,
  jobId: string,
): Promise<{ job: JobRow; actor: DecisionActor }> {
  const journal = await getJob(db, jobId);
  if (!journal || journal.job.leagueId === null) throw notFound('Job not found');
  const { access } = await requireLeagueAccess(db, auth, journal.job.leagueId);
  return {
    job: journal.job,
    actor: { userId: auth.userId, capabilities: access.capabilities },
  };
}

/**
 * Re-reads a preview after a racing approval won it: the winner's job back
 * (idempotent), or the reason this approval cannot proceed.
 */
async function racedApproval(db: Db, previewId: string): Promise<JobRow> {
  const reread = await getPreview(db, previewId);
  if (reread?.consumedAt && reread.jobId) {
    const journal = await getJob(db, reread.jobId);
    if (journal) return journal.job;
  }
  if (reread?.consumedAt) {
    throw new HttpError(409, 'preview_consumed: this preview has already been consumed');
  }
  // The preview is still open, so the duplicate guard fired against another
  // preview's active job with the same plan hash (02 §5.10).
  throw new HttpError(
    409,
    'active_duplicate: an active job with the same plan hash is already running for this league',
  );
}

export interface JobRouteDeps {
  config: Config;
  db: Db;
  /** Creates the Citadel client for a league key; injected so tests can use a fake. */
  citadel?: CitadelClientFactory | undefined;
}

export function registerJobRoutes(app: FastifyInstance, deps: JobRouteDeps): void {
  const secure = useSecureCookies(deps.config.publicBaseUrl);
  const source: PlanSource = {
    db: deps.db,
    config: deps.config,
    citadel: deps.citadel ?? defaultCitadelFactory,
  };

  app.get('/api/v1/leagues/:leagueId/jobs', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    const { leagueId } = await requireLeagueCapability(deps.db, request, auth, 'league.read');
    const query = parseQuery(listQuery, request);
    const jobs = await listJobsByLeague(deps.db, leagueId, {
      ...(query.state !== undefined ? { state: query.state } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
    return reply.send({ jobs: jobs.map(serialiseJob) });
  });

  app.get('/api/v1/jobs/:jobId', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    const jobId = jobIdOf(request.params);
    const journal = await getJob(deps.db, jobId);
    // League-scoped only: an unknown job and a guild-scoped job are the same
    // answer to a caller of the league API.
    if (!journal || journal.job.leagueId === null) throw notFound('Job not found');
    await requireLeagueCapabilityOn(deps.db, auth, journal.job.leagueId, 'league.read');
    return reply.send({
      job: serialiseJob(journal.job),
      steps: journal.steps.map(serialiseStep),
      events: journal.events.map(serialiseEvent),
    });
  });

  app.post('/api/v1/jobs', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    const body = parseBody(approveBody, request);
    const preview = await getPreview(deps.db, body.previewId);
    if (!preview) throw notFound('Preview not found');

    // Idempotent approval (02 §5.2): a preview that already produced its job
    // returns that job, never a second one.
    if (preview.consumedAt) {
      if (preview.jobId) {
        const journal = await getJob(deps.db, preview.jobId);
        if (journal) return reply.send({ job: serialiseJob(journal.job) });
      }
      throw new HttpError(409, 'preview_consumed: this preview has already been consumed');
    }

    // Approving the setup is the same capability as building it.
    const { league } = await requireLeagueCapabilityOn(
      deps.db,
      auth,
      preview.leagueId,
      'tournament.setup',
    );

    if (preview.expiresAt !== null && preview.expiresAt.getTime() <= Date.now()) {
      throw new HttpError(409, 'preview_expired: the preview has expired; build it again');
    }

    // Drift check (02 §6.8): the live plan must still hash to the stored
    // hash, so the job binds to the plan the admin approved - and nothing is
    // created when Citadel has moved on.
    const { plan } = await livePlanForLeague(source, league);
    if (plan.planHash !== preview.planHash) {
      throw new HttpError(
        409,
        'plan_changed: the league changed since the preview was built; preview it again',
      );
    }

    let job: JobRow;
    try {
      job = await deps.db.transaction(async (tx) => {
        const created = await createJob(tx, {
          type: 'tournament.setup',
          guildId: league.guildId,
          leagueId: preview.leagueId,
          lane: 'setup',
          params: { previewId: preview.id },
          plan: plan as unknown as Record<string, unknown>,
          planHash: preview.planHash,
          requestedByUserId: auth.userId,
          requestedByDiscordId: auth.discordId,
          steps: planStepInputs(plan),
        });
        const consumed = await consumePreviewForJob(tx, preview.id, created.id);
        if (!consumed) throw new PreviewRaced();
        return created;
      });
    } catch (error) {
      if (error instanceof PreviewRaced) {
        const winner = await racedApproval(deps.db, preview.id);
        return reply.send({ job: serialiseJob(winner) });
      }
      if (error instanceof ConflictError) {
        // The duplicate guard fired: either a racing approval of this same
        // preview won (idempotent), or another active job holds the hash.
        const winner = await racedApproval(deps.db, preview.id);
        return reply.send({ job: serialiseJob(winner) });
      }
      throw error;
    }

    await audit(deps.db, request, auth, {
      action: 'job.create',
      targetType: 'job',
      targetId: job.id,
      guildId: job.guildId,
      leagueId: job.leagueId,
      after: { previewId: preview.id, planHash: job.planHash, type: job.type },
    });

    return reply.status(201).send({ job: serialiseJob(job) });
  });

  app.post('/api/v1/jobs/:jobId/decision', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    const jobId = jobIdOf(request.params);
    const body = parseBody(decisionBody, request);
    const { job, actor } = await loadDecisionJob(deps.db, auth, jobId);

    const decision = decisionOf(body);
    const updated = await applyDecisionOrHttpError(deps.db, jobId, decision, actor);

    await audit(deps.db, request, auth, {
      action: 'job.decision',
      targetType: 'job',
      targetId: jobId,
      guildId: job.guildId,
      leagueId: job.leagueId,
      after: { type: body.type, state: updated.state },
    });

    return reply.send({ job: serialiseJob(updated) });
  });

  app.post('/api/v1/jobs/:jobId/cancel', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    const jobId = jobIdOf(request.params);
    const { job, actor } = await loadDecisionJob(deps.db, auth, jobId);

    // An operator cancel of an active job is the machine's cancel edge out
    // of queued|running|paused, and the abort answer to an awaiting_decision
    // prompt - one engine move, objects left exactly as they are.
    const updated = await applyDecisionOrHttpError(deps.db, jobId, { type: 'abort' }, actor);

    await audit(deps.db, request, auth, {
      action: 'job.cancel',
      targetType: 'job',
      targetId: jobId,
      guildId: job.guildId,
      leagueId: job.leagueId,
      after: { state: updated.state },
    });

    return reply.send({ job: serialiseJob(updated) });
  });
}
