import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { getDashboard } from '../api.js';
import { JobTable } from '../job-table.js';
import { ErrorNote, useMe } from '../layout.js';

export function HomePage() {
  const me = useMe();
  const dashboard = useQuery({ queryKey: ['dashboard'], queryFn: getDashboard });

  const activity = dashboard.data?.activity ?? [];
  const leagues = new Map((dashboard.data?.leagues ?? []).map((league) => [league.id, league]));
  const allJobs = activity.flatMap(({ league, jobs }) => jobs.map((job) => ({ job, league })));
  const awaiting = allJobs
    .filter(({ job }) => job.state === 'awaiting_decision')
    .sort((a, b) => b.job.updatedAt.localeCompare(a.job.updatedAt));
  const alerts = activity
    .flatMap(({ league, alerts: leagueAlerts }) => leagueAlerts.map((alert) => ({ alert, league })))
    .sort((a, b) => b.alert.openedAt.localeCompare(a.alert.openedAt));
  const recentJobs = allJobs
    .sort((a, b) => b.job.updatedAt.localeCompare(a.job.updatedAt))
    .slice(0, 8)
    .map(({ job }) => job);

  return (
    <div className="stack">
      <section>
        <h1>Welcome back</h1>
        <p className="muted">
          Signed in as {me.data?.user.displayName} ({me.data?.user.tier}).
        </p>
      </section>

      {dashboard.isLoading ? (
        <p className="muted" role="status" data-testid="dashboard-loading">
          Loading dashboard...
        </p>
      ) : null}
      {dashboard.error ? (
        <div data-testid="dashboard-error">
          <ErrorNote error={dashboard.error} />
        </div>
      ) : null}

      {dashboard.data ? (
        <>
          <section className="card stack" data-testid="needs-attention">
            <div className="section-head">
              <h2>Needs attention</h2>
              <span className={`pill ${awaiting.length + alerts.length ? 'warning' : 'ok'}`}>
                {awaiting.length + alerts.length} open
              </span>
            </div>
            <div className="grid">
              <div>
                <h2>Jobs awaiting decision</h2>
                {awaiting.length ? (
                  <div className="stack">
                    {awaiting.slice(0, 5).map(({ job, league }) => (
                      <div
                        className="notice warning"
                        key={job.id}
                        data-testid="awaiting-job"
                        data-job-id={job.id}
                      >
                        <Link to="/jobs/$jobId" params={{ jobId: job.id }}>
                          {job.type}
                        </Link>
                        <p className="small">
                          {league.name || league.shortcode} ·{' '}
                          {new Date(job.updatedAt).toLocaleString()}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted" data-testid="awaiting-jobs-empty">
                    No jobs are waiting for a decision.
                  </p>
                )}
              </div>
              <div>
                <h2>Open alerts</h2>
                {alerts.length ? (
                  <div className="stack">
                    {alerts.slice(0, 5).map(({ alert, league }) => (
                      <div
                        className={alert.severity === 'critical' ? 'error' : 'notice warning'}
                        key={alert.id}
                        data-testid="open-alert"
                        data-alert-id={alert.id}
                      >
                        <strong>{alert.kind}</strong>
                        <p className="small">
                          {league.name || league.shortcode} · {alert.severity} ·{' '}
                          {new Date(alert.openedAt).toLocaleString()}
                        </p>
                        {alert.jobId ? (
                          <Link to="/jobs/$jobId" params={{ jobId: alert.jobId }}>
                            Open job
                          </Link>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted" data-testid="open-alerts-empty">
                    No open alerts.
                  </p>
                )}
              </div>
            </div>
          </section>

          <section className="stack" data-testid="recent-jobs">
            <div className="section-head">
              <h2>Recent jobs</h2>
              <span className="muted small">{allJobs.length} loaded</span>
            </div>
            {recentJobs.length ? (
              <JobTable jobs={recentJobs} leagues={leagues} testId="recent-jobs-table" />
            ) : (
              <div className="card muted" data-testid="recent-jobs-empty">
                No jobs have been created in your leagues yet.
              </div>
            )}
          </section>

          <section className="stack" data-testid="dashboard-leagues">
            <div className="section-head">
              <h2>Leagues</h2>
              <Link to="/leagues">All leagues</Link>
            </div>
            {dashboard.data.leagues.length === 0 ? (
              <p className="muted" data-testid="dashboard-leagues-empty">
                No leagues yet.
              </p>
            ) : null}
            <div className="grid">
              {dashboard.data.leagues.slice(0, 6).map((league) => (
                <Link
                  key={league.id}
                  to="/leagues/$leagueId"
                  params={{ leagueId: league.id }}
                  className="card link-card"
                >
                  <strong>{league.name}</strong>
                  <span className="muted">
                    {league.shortcode} · Citadel #{league.citadelLeagueId}
                  </span>
                  <span className={`pill ${league.status}`}>{league.status}</span>
                </Link>
              ))}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
