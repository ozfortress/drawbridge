import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiError, getLeague, getLeagueJobs, type JobState } from '../api.js';
import { JobTable } from '../job-table.js';
import { ErrorNote } from '../layout.js';
import { useJobStream } from '../use-job-stream.js';

type JobFilter = 'all' | JobState;

const FILTERS: JobFilter[] = [
  'all',
  'queued',
  'running',
  'paused',
  'awaiting_decision',
  'completed',
  'completed_with_skips',
  'failed',
  'cancelled',
  'reverting',
  'reverted',
];

function isAuthError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function JobQueuePage() {
  const { leagueId } = useParams({ from: '/authed/leagues/$leagueId/jobs' });
  const [filter, setFilter] = useState<JobFilter>('all');
  const league = useQuery({
    queryKey: ['league', leagueId],
    queryFn: () => getLeague(leagueId),
  });
  const jobs = useQuery({
    queryKey: ['jobs', leagueId, filter],
    queryFn: () => getLeagueJobs(leagueId, filter === 'all' ? undefined : filter),
  });
  const streamStatus = useJobStream(league.data ? leagueId : null);

  if (isAuthError(league.error) || isAuthError(jobs.error)) return <Navigate to="/signin" />;
  if (league.isLoading) {
    return (
      <p className="muted" role="status" data-testid="job-queue-loading">
        Loading job queue...
      </p>
    );
  }
  if (league.error) {
    return (
      <div data-testid="job-queue-error">
        <ErrorNote error={league.error} />
      </div>
    );
  }
  if (!league.data) return null;

  const leagueDetail = league.data.league;
  const leagues = new Map([[leagueDetail.id, leagueDetail]]);

  return (
    <div className="stack" data-testid="job-queue-page">
      <div className="section-head">
        <div>
          <h1>{leagueDetail.name || leagueDetail.shortcode} jobs</h1>
          <p className="muted">
            {leagueDetail.shortcode} ·{' '}
            <span data-testid="job-stream-status">
              {streamStatus === 'live'
                ? 'Live updates connected'
                : streamStatus === 'reconnecting'
                  ? 'Live updates reconnecting...'
                  : 'Connecting live updates...'}
            </span>
          </p>
        </div>
        <Link
          to="/leagues/$leagueId"
          params={{ leagueId }}
          className="button ghost"
          data-testid="queue-league-link"
        >
          League details
        </Link>
      </div>

      <section className="stack">
        <div className="section-head">
          <h2>Job queue</h2>
          <label className="small muted">
            State{' '}
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value as JobFilter)}
              data-testid="job-state-filter"
            >
              {FILTERS.map((state) => (
                <option key={state} value={state}>
                  {state === 'all' ? 'All states' : state.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </label>
        </div>

        {jobs.isLoading ? (
          <p className="muted" role="status" data-testid="job-queue-loading">
            Loading jobs...
          </p>
        ) : null}
        {jobs.error ? (
          <div data-testid="job-queue-error">
            <ErrorNote error={jobs.error} />
          </div>
        ) : null}
        {jobs.data?.jobs.length ? (
          <JobTable jobs={jobs.data.jobs} leagues={leagues} testId="job-queue" />
        ) : null}
        {jobs.data && jobs.data.jobs.length === 0 ? (
          <div className="card muted" role="status" data-testid="job-queue-empty">
            {filter === 'all'
              ? 'No jobs have been created for this league yet.'
              : `No jobs in ${filter.replaceAll('_', ' ')}.`}
          </div>
        ) : null}
      </section>
    </div>
  );
}
