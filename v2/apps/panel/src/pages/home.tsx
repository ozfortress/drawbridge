import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { getLeagues } from '../api.js';
import { ErrorNote, useMe } from '../layout.js';

export function HomePage() {
  const me = useMe();
  const leagues = useQuery({ queryKey: ['leagues'], queryFn: getLeagues });
  const isStaff = me.data?.user.tier === 'root' || me.data?.user.tier === 'admin';

  return (
    <div className="stack">
      <section>
        <h1>Welcome back</h1>
        <p className="muted">
          Signed in as {me.data?.user.displayName} ({me.data?.user.tier}).
        </p>
      </section>

      {isStaff ? (
        <section className="card">
          <h2>Needs attention</h2>
          <p className="muted">
            Jobs awaiting a decision and open alerts will appear here once the job engine lands
            (P3).
          </p>
        </section>
      ) : null}

      <section>
        <div className="section-head">
          <h2>Leagues</h2>
          <Link to="/leagues">All leagues</Link>
        </div>
        {leagues.isLoading ? <p className="muted">Loading leagues…</p> : null}
        {leagues.error ? <ErrorNote error={leagues.error} /> : null}
        {leagues.data && leagues.data.leagues.length === 0 ? (
          <p className="muted">No leagues yet.</p>
        ) : null}
        <div className="grid">
          {leagues.data?.leagues.slice(0, 6).map((league) => (
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
    </div>
  );
}
