import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { api, getMe, type Me } from './api.js';

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: getMe, retry: false, staleTime: 30_000 });
}

export function AuthedLayout({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isLoading) return <div className="center muted">Loading…</div>;
  if (me.isError || !me.data) return <Navigate to="/signin" />;
  return <Shell me={me.data}>{children}</Shell>;
}

function Shell({ me, children }: { me: Me; children: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isStaff = me.user.tier === 'root' || me.user.tier === 'admin';

  async function signOut() {
    try {
      await api('/api/v1/auth/logout', { method: 'POST' });
    } finally {
      queryClient.clear();
      await navigate({ to: '/signin' });
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">DB</span>
          <span>Drawbridge</span>
        </div>
        <nav className="nav">
          <Link to="/" activeOptions={{ exact: true }}>
            Home
          </Link>
          <Link to="/leagues">Leagues</Link>
          {isStaff ? <Link to="/users">Users</Link> : null}
          {isStaff ? <Link to="/audit">Audit</Link> : null}
        </nav>
        <div className="user">
          <span className="tier">{me.user.tier}</span>
          <span>{me.user.displayName || me.user.discordId}</span>
          <button type="button" className="ghost" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="content">{children}</main>
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return <div className="error">{message}</div>;
}
