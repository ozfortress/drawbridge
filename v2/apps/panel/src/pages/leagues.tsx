import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api, getLeagues, type League } from '../api.js';
import { ErrorNote, useMe } from '../layout.js';

export function LeaguesPage() {
  const me = useMe();
  const leagues = useQuery({ queryKey: ['leagues'], queryFn: getLeagues });
  const client = useQueryClient();
  const navigate = useNavigate();
  const [guildId, setGuildId] = useState('');
  const [citadelLeagueId, setCitadelLeagueId] = useState('');
  const [name, setName] = useState('');
  const [shortcode, setShortcode] = useState('');

  const canCreate = me.data && me.data.user.tier !== 'guest';

  const create = useMutation({
    mutationFn: () =>
      api<{ league: League }>('/api/v1/leagues', {
        method: 'POST',
        body: JSON.stringify({
          guildId,
          citadelLeagueId: Number(citadelLeagueId),
          name,
          shortcode,
        }),
      }),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ['leagues'] });
      await navigate({ to: '/leagues/$leagueId', params: { leagueId: result.league.id } });
    },
  });

  return (
    <div className="stack">
      <h1>Leagues</h1>
      {leagues.isLoading ? <p className="muted">Loading…</p> : null}
      {leagues.error ? <ErrorNote error={leagues.error} /> : null}

      {leagues.data?.leagues.length ? (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Shortcode</th>
              <th>Citadel</th>
              <th>Status</th>
              <th>Time zone</th>
            </tr>
          </thead>
          <tbody>
            {leagues.data.leagues.map((league) => (
              <tr key={league.id}>
                <td>
                  <Link to="/leagues/$leagueId" params={{ leagueId: league.id }}>
                    {league.name || '(unnamed)'}
                  </Link>
                </td>
                <td>{league.shortcode}</td>
                <td>#{league.citadelLeagueId}</td>
                <td>
                  <span className={`pill ${league.status}`}>{league.status}</span>
                </td>
                <td>{league.timezone}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No leagues yet.</p>
      )}

      {canCreate ? (
        <section className="card">
          <h2>Import a league</h2>
          <p className="muted">
            Registering a league creates it in draft. Citadel import and preview arrive in P2.
          </p>
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <label>
              Discord server ID
              <input
                value={guildId}
                onChange={(event) => setGuildId(event.target.value)}
                placeholder="1573554616371777546"
                required
              />
            </label>
            <label>
              Citadel league ID
              <input
                value={citadelLeagueId}
                onChange={(event) => setCitadelLeagueId(event.target.value)}
                type="number"
                min="1"
                required
              />
            </label>
            <label>
              Name
              <input value={name} onChange={(event) => setName(event.target.value)} required />
            </label>
            <label>
              Shortcode
              <input
                value={shortcode}
                onChange={(event) => setShortcode(event.target.value)}
                maxLength={20}
                required
              />
            </label>
            <button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create league'}
            </button>
            {create.error ? <ErrorNote error={create.error} /> : null}
          </form>
        </section>
      ) : null}
    </div>
  );
}
