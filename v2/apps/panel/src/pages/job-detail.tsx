import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useParams } from '@tanstack/react-router';
import {
  ApiError,
  decideJob,
  getJob,
  type JobDecision,
  type JobDetail,
  type JobStep,
} from '../api.js';
import { JobStatePill } from '../job-table.js';
import { ErrorNote } from '../layout.js';
import { useJobStream } from '../use-job-stream.js';

const ERROR_TAXONOMY: Record<string, { title: string; description: string }> = {
  fatal_config: {
    title: 'Fatal Discord configuration',
    description:
      'Discord authentication failed. All writes stay stopped until the bot token or configuration is fixed.',
  },
  missing_permission: {
    title: 'Missing Discord permission',
    description: 'The bot is missing the role or channel access this step needs.',
  },
  object_missing: {
    title: 'Discord object missing',
    description: 'A Discord object this step depends on no longer exists.',
  },
  capacity: {
    title: 'Discord capacity reached',
    description: 'A Discord capacity limit was reached before this step could finish.',
  },
  invalid_input: {
    title: 'Invalid Discord request',
    description: 'Discord rejected the request. The plan or configuration must be corrected.',
  },
  transient: {
    title: 'Temporary upstream failure',
    description: 'The step did not recover before its automatic retries were exhausted.',
  },
  rate_limited: {
    title: 'Discord rate limit',
    description: 'Discord rate limited this step before it could finish.',
  },
};

function errorValue(error: Record<string, unknown>, key: string): string | null {
  const value = error[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function JobErrorNotice({ error }: { error: Record<string, unknown> }) {
  const classification = errorValue(error, 'class') ?? 'unclassified';
  const taxonomy = ERROR_TAXONOMY[classification] ?? {
    title: 'Job error',
    description: 'The job could not continue. Inspect the journal before choosing an action.',
  };
  const stepSeq = errorValue(error, 'stepSeq');
  const message = errorValue(error, 'message');
  const code = errorValue(error, 'code');

  return (
    <div className="error" role="alert" data-testid="job-error">
      <strong>{taxonomy.title}</strong>
      <p>{taxonomy.description}</p>
      <p className="small">
        Taxonomy:{' '}
        <span className="mono" data-testid="job-error-class">
          {classification}
        </span>
        {stepSeq ? ` · Step ${stepSeq}` : ''}
        {code ? ` · Code ${code}` : ''}
      </p>
      {message ? <p className="small">{message}</p> : null}
    </div>
  );
}

function decisionLabel(decision: JobDecision): string {
  switch (decision.type) {
    case 'retry':
      return 'Retry failed step';
    case 'skip':
      return `Skip step ${decision.stepSeq}`;
    case 'adopt':
      return `Adopt step ${decision.stepSeq}`;
    case 'revert':
      return 'Revert changes';
    case 'abort':
      return 'Abort job';
  }
}

function decisionTestId(decision: JobDecision): string {
  return `decision-${decision.type}${'stepSeq' in decision ? `-${decision.stepSeq}` : ''}`;
}

function stepError(step: JobStep): string | null {
  return step.error ? errorValue(step.error, 'message') : null;
}

export function JobDetailPage() {
  const { jobId } = useParams({ from: '/authed/jobs/$jobId' });
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ['job', jobId], queryFn: () => getJob(jobId) });
  const streamStatus = useJobStream(detail.data?.job.leagueId ?? null);
  const decision = useMutation({
    mutationFn: (input: JobDecision) => decideJob(jobId, input),
    onSuccess: async ({ job }) => {
      queryClient.setQueryData<JobDetail | undefined>(['job', jobId], (current) =>
        current ? { ...current, job } : current,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['job', jobId] }),
        queryClient.invalidateQueries({ queryKey: ['jobs', job.leagueId] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    },
  });

  if (detail.error instanceof ApiError && detail.error.status === 401) {
    return <Navigate to="/signin" />;
  }
  if (detail.isLoading) {
    return (
      <p className="muted" role="status" data-testid="job-detail-loading">
        Loading job detail...
      </p>
    );
  }
  if (detail.error) {
    return (
      <div data-testid="job-detail-error">
        <ErrorNote error={detail.error} />
      </div>
    );
  }
  if (!detail.data) return null;

  const { job, steps, events, allowedDecisions } = detail.data;
  const visibleError = job.error ?? steps.find((step) => step.error)?.error ?? null;
  const requester = job.requestedByDiscordId ?? job.requestedByUserId;

  return (
    <div className="stack" data-testid="job-detail-page" data-job-id={job.id}>
      <div className="section-head">
        <div>
          <h1>{job.type}</h1>
          <p className="muted small mono">{job.id}</p>
        </div>
        <span data-testid="job-state" data-state={job.state}>
          <JobStatePill state={job.state} />
        </span>
      </div>

      <div className="section-head">
        <Link
          to="/leagues/$leagueId/jobs"
          params={{ leagueId: job.leagueId }}
          data-testid="detail-queue-link"
        >
          Back to job queue
        </Link>
        <span className="muted small" data-testid="job-stream-status">
          {streamStatus === 'live'
            ? 'Live updates connected'
            : streamStatus === 'reconnecting'
              ? 'Live updates reconnecting...'
              : 'Connecting live updates...'}
        </span>
      </div>

      <dl className="card key-meta" data-testid="job-metadata">
        <div>
          <dt>League</dt>
          <dd className="mono">{job.leagueId}</dd>
        </div>
        <div>
          <dt>Requested by</dt>
          <dd className="mono">{requester ?? 'System'}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{new Date(job.updatedAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Attempt</dt>
          <dd>{job.attempt}</dd>
        </div>
        <div>
          <dt>Plan</dt>
          <dd className="mono" title={job.planHash}>
            {job.planHash.slice(0, 12)}
          </dd>
        </div>
        {job.pauseReason ? (
          <div>
            <dt>Pause reason</dt>
            <dd>{job.pauseReason.replaceAll('_', ' ')}</dd>
          </div>
        ) : null}
      </dl>

      {visibleError ? <JobErrorNotice error={visibleError} /> : null}

      <section className="card stack" data-testid="job-decisions">
        <div>
          <h2>Decisions</h2>
          <p className="muted small">
            Actions are supplied by the server for this job state and your access.
          </p>
        </div>
        {allowedDecisions.length ? (
          <div className="actions">
            {allowedDecisions.map((item) => (
              <button
                key={decisionTestId(item)}
                type="button"
                className={item.type === 'revert' || item.type === 'abort' ? 'ghost' : undefined}
                disabled={decision.isPending}
                onClick={() => decision.mutate(item)}
                data-testid={decisionTestId(item)}
              >
                {decision.isPending && decision.variables === item
                  ? 'Applying…'
                  : decisionLabel(item)}
              </button>
            ))}
          </div>
        ) : (
          <p className="muted" data-testid="job-decisions-empty">
            No decisions are available for this job state or your access.
          </p>
        )}
        {decision.error ? (
          <div data-testid="job-decision-error">
            <ErrorNote error={decision.error} />
          </div>
        ) : null}
      </section>

      <section className="stack">
        <h2>Steps</h2>
        {steps.length ? (
          <div className="table-wrap">
            <table className="table" data-testid="job-steps">
              <thead>
                <tr>
                  <th>Seq</th>
                  <th>Step</th>
                  <th>State</th>
                  <th>Attempts</th>
                  <th>Started</th>
                  <th>Finished</th>
                </tr>
              </thead>
              <tbody>
                {steps.map((step) => {
                  const message = stepError(step);
                  return (
                    <tr key={step.seq} data-testid="job-step" data-step-seq={step.seq}>
                      <td>{step.seq}</td>
                      <td>
                        <span className="mono">{step.kind}</span>
                        {message ? <div className="muted small">{message}</div> : null}
                      </td>
                      <td>
                        <span className={`pill ${step.status}`}>
                          {step.status.replaceAll('_', ' ')}
                        </span>
                      </td>
                      <td>{step.attempts}</td>
                      <td>{step.startedAt ? new Date(step.startedAt).toLocaleString() : '-'}</td>
                      <td>{step.finishedAt ? new Date(step.finishedAt).toLocaleString() : '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="card muted" data-testid="job-steps-empty">
            No steps were recorded for this job.
          </div>
        )}
      </section>

      <section className="stack">
        <h2>Events</h2>
        {events.length ? (
          <div className="table-wrap">
            <table className="table" data-testid="job-events">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Level</th>
                  <th>Event</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id} data-testid="job-event" data-event-code={event.code}>
                    <td>
                      <time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time>
                    </td>
                    <td>
                      <span className={`pill ${event.level}`}>{event.level}</span>
                    </td>
                    <td>
                      {event.message}
                      <div className="muted small mono">{event.code}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="card muted" data-testid="job-events-empty">
            No events were recorded for this job.
          </div>
        )}
      </section>
    </div>
  );
}
