import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { api, getLeague, type LeagueDetail } from '../api.js';
import { ErrorNote } from '../layout.js';

export function LeagueDetailPage() {
  const { leagueId } = useParams({ from: '/authed/leagues/$leagueId' });
  const detail = useQuery({ queryKey: ['league', leagueId], queryFn: () => getLeague(leagueId) });
  const client = useQueryClient();
  const [name, setName] = useState<string | null>(null);

  const rename = useMutation({
    mutationFn: (value: string) =>
      api<{ league: LeagueDetail['league'] }>(`/api/v1/leagues/${leagueId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: value }),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['league', leagueId] });
      await client.invalidateQueries({ queryKey: ['leagues'] });
      setName(null);
    },
  });

  if (detail.isLoading) return <p className="muted">Loading league…</p>;
  if (detail.error) return <ErrorNote error={detail.error} />;
  if (!detail.data) return null;

  const { league, access, roles } = detail.data;
  const canWrite = access.capabilities.includes('league.settings.write');

  return (
    <div className="stack">
      <div className="section-head">
        <h1>{league.name || '(unnamed league)'}</h1>
        <div className="actions">
          {access.capabilities.includes('tournament.setup') ? (
            <Link to="/leagues/$leagueId/setup" params={{ leagueId: league.id }} className="button">
              Setup preview
            </Link>
          ) : null}
          <span className={`pill ${league.status}`}>{league.status}</span>
        </div>
      </div>
      <p className="muted">
        {league.shortcode} · Citadel #{league.citadelLeagueId} · {league.timezone}
      </p>

      <section className="card">
        <h2>Your access</h2>
        <p className="muted">
          Tier: {access.tier} · League rank: {access.leagueRank ?? 'n/a'}
        </p>
        <div className="tags">
          {access.capabilities.map((capability) => (
            <span key={capability} className="tag">
              {capability}
            </span>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>League hierarchy</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Role</th>
              <th>Capabilities</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((role) => (
              <tr key={role.id}>
                <td>{role.rank}</td>
                <td>{role.name}</td>
                <td className="tags">
                  {role.capabilities.length === 0 ? (
                    <span className="muted">none</span>
                  ) : (
                    role.capabilities.map((capability) => (
                      <span key={capability} className="tag">
                        {capability}
                      </span>
                    ))
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {canWrite ? (
        <section className="card">
          <h2>Settings</h2>
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              rename.mutate(name ?? league.name);
            }}
          >
            <label>
              Name
              <input
                value={name ?? league.name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
            <button type="submit" disabled={rename.isPending}>
              {rename.isPending ? 'Saving…' : 'Save'}
            </button>
            {rename.error ? <ErrorNote error={rename.error} /> : null}
          </form>
        </section>
      ) : null}
    </div>
  );
}
