import { Link } from '@tanstack/react-router';
import type { Job, League } from './api.js';

export function JobStatePill({ state }: { state: Job['state'] }) {
  return <span className={`pill ${state}`}>{state.replaceAll('_', ' ')}</span>;
}

export function JobTable({
  jobs,
  leagues,
  testId,
}: {
  jobs: Job[];
  leagues: ReadonlyMap<string, League>;
  testId: string;
}) {
  return (
    <div className="table-wrap">
      <table className="table" data-testid={testId}>
        <thead>
          <tr>
            <th>State</th>
            <th>Type</th>
            <th>League</th>
            <th>Requested by</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const league = leagues.get(job.leagueId);
            const requester = job.requestedByDiscordId ?? job.requestedByUserId;
            return (
              <tr key={job.id} data-testid="job-row" data-job-id={job.id} data-state={job.state}>
                <td>
                  <JobStatePill state={job.state} />
                </td>
                <td>
                  <Link to="/jobs/$jobId" params={{ jobId: job.id }} data-testid="job-open">
                    {job.type}
                  </Link>
                  <div className="muted small mono" title={job.id}>
                    {job.id.slice(0, 8)}
                  </div>
                </td>
                <td>
                  {league ? (
                    <>
                      <strong>{league.name || league.shortcode}</strong>
                      <div className="muted small">{league.shortcode}</div>
                    </>
                  ) : (
                    <span className="mono">{job.leagueId}</span>
                  )}
                </td>
                <td>
                  {requester ? (
                    <span className="mono small">{requester}</span>
                  ) : (
                    <span className="muted">System</span>
                  )}
                </td>
                <td>
                  <time dateTime={job.updatedAt}>{new Date(job.updatedAt).toLocaleString()}</time>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
