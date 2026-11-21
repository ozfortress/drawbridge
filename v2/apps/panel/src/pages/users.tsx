import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, getUsers, type UserRow } from '../api.js';
import { ErrorNote, useMe } from '../layout.js';

const TIER_ORDER = ['root', 'admin', 'helper', 'user', 'guest'] as const;

function manageableTiers(actor: string): string[] {
  if (actor === 'root') return [...TIER_ORDER];
  return ['helper', 'user', 'guest'];
}

export function UsersPage() {
  const me = useMe();
  const users = useQuery({ queryKey: ['users'], queryFn: getUsers });
  const client = useQueryClient();
  const [discordId, setDiscordId] = useState('');
  const [globalRole, setGlobalRole] = useState('user');

  const tier = me.data?.user.tier ?? 'guest';
  const isStaff = tier === 'root' || tier === 'admin';

  const invite = useMutation({
    mutationFn: () =>
      api('/api/v1/users/invites', {
        method: 'POST',
        body: JSON.stringify({ discordId, globalRole }),
      }),
    onSuccess: async () => {
      setDiscordId('');
      await client.invalidateQueries({ queryKey: ['users'] });
    },
  });

  const update = useMutation({
    mutationFn: (input: { userId: string; body: Record<string, string> }) =>
      api(`/api/v1/users/${input.userId}`, {
        method: 'PATCH',
        body: JSON.stringify(input.body),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['users'] });
    },
  });

  const revoke = useMutation({
    mutationFn: (userId: string) =>
      api(`/api/v1/users/${userId}/revoke-sessions`, { method: 'POST' }),
  });

  if (!isStaff) {
    return <div className="error">You do not have access to user management.</div>;
  }

  return (
    <div className="stack">
      <h1>Users</h1>
      <p className="muted">
        Invite by Discord user ID. Invited users join at first sign-in with the tier you choose.
      </p>

      <section className="card">
        <h2>Invite a user</h2>
        <form
          className="form inline"
          onSubmit={(event) => {
            event.preventDefault();
            invite.mutate();
          }}
        >
          <label>
            Discord user ID
            <input
              value={discordId}
              onChange={(event) => setDiscordId(event.target.value)}
              placeholder="136264506933248000"
              required
            />
          </label>
          <label>
            Tier
            <select value={globalRole} onChange={(event) => setGlobalRole(event.target.value)}>
              {manageableTiers(tier)
                .filter((option) => option !== 'root' || tier === 'root')
                .map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
            </select>
          </label>
          <button type="submit" disabled={invite.isPending}>
            {invite.isPending ? 'Inviting…' : 'Invite'}
          </button>
          {invite.error ? <ErrorNote error={invite.error} /> : null}
        </form>
      </section>

      {users.error ? <ErrorNote error={users.error} /> : null}
      {users.data ? (
        <table className="table">
          <thead>
            <tr>
              <th>User</th>
              <th>Discord ID</th>
              <th>Tier</th>
              <th>Status</th>
              <th>Last sign-in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.data.users.map((row) => (
              <UserTableRow
                key={row.id}
                row={row}
                actorTier={tier}
                onChange={(body) => update.mutate({ userId: row.id, body })}
                onRevoke={() => revoke.mutate(row.id)}
                busy={update.isPending || revoke.isPending}
              />
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function UserTableRow({
  row,
  actorTier,
  onChange,
  onRevoke,
  busy,
}: {
  row: UserRow;
  actorTier: string;
  onChange: (body: Record<string, string>) => void;
  onRevoke: () => void;
  busy: boolean;
}) {
  const [draftRole, setDraftRole] = useState(row.globalRole);
  const canManage =
    actorTier === 'root' ||
    (actorTier === 'admin' && row.globalRole !== 'root' && row.globalRole !== 'admin');
  const disabled = row.status === 'disabled';

  return (
    <tr>
      <td>{row.displayName || '—'}</td>
      <td className="mono">{row.discordId}</td>
      <td>
        {canManage ? (
          <select value={draftRole} onChange={(event) => setDraftRole(event.target.value)}>
            {manageableTiers(actorTier).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : (
          row.globalRole
        )}
      </td>
      <td>
        <span className={`pill ${row.status}`}>{row.status}</span>
      </td>
      <td>{row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleString() : 'never'}</td>
      <td className="actions">
        {canManage && draftRole !== row.globalRole ? (
          <button type="button" disabled={busy} onClick={() => onChange({ globalRole: draftRole })}>
            Save
          </button>
        ) : null}
        {canManage ? (
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => onChange({ status: disabled ? 'active' : 'disabled' })}
          >
            {disabled ? 'Enable' : 'Disable'}
          </button>
        ) : null}
        {canManage ? (
          <button type="button" className="ghost" disabled={busy} onClick={onRevoke}>
            Sign out
          </button>
        ) : null}
      </td>
    </tr>
  );
}
