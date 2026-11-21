import { useQuery } from '@tanstack/react-query';
import { getAudit } from '../api.js';
import { ErrorNote, useMe } from '../layout.js';

export function AuditPage() {
  const me = useMe();
  const audit = useQuery({ queryKey: ['audit'], queryFn: getAudit });
  const tier = me.data?.user.tier ?? 'guest';

  if (tier !== 'root' && tier !== 'admin') {
    return <div className="error">You do not have access to the audit log.</div>;
  }

  return (
    <div className="stack">
      <h1>Audit log</h1>
      {audit.isLoading ? <p className="muted">Loading…</p> : null}
      {audit.error ? <ErrorNote error={audit.error} /> : null}
      {audit.data ? (
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>
            {audit.data.entries.map((entry) => (
              <tr key={entry.id}>
                <td>{new Date(entry.at).toLocaleString()}</td>
                <td className="mono">{entry.actorDiscordId ?? '—'}</td>
                <td className="mono">{entry.action}</td>
                <td>
                  {entry.targetType ?? '—'}{' '}
                  {entry.targetId ? <span className="mono">{entry.targetId}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {audit.data && audit.data.entries.length === 0 ? (
        <p className="muted">No entries yet.</p>
      ) : null}
    </div>
  );
}
