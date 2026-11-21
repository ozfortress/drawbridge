import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { AuthedLayout } from './layout.js';
import { AuditPage } from './pages/audit.js';
import { HomePage } from './pages/home.js';
import { LeagueDetailPage } from './pages/league-detail.js';
import { LeaguesPage } from './pages/leagues.js';
import { SignInPage } from './pages/signin.js';
import { UsersPage } from './pages/users.js';

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signin',
  component: SignInPage,
});

const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authed',
  component: () => (
    <AuthedLayout>
      <Outlet />
    </AuthedLayout>
  ),
});

const homeRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/',
  component: HomePage,
});

const leaguesRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/leagues',
  component: LeaguesPage,
});

const leagueDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/leagues/$leagueId',
  component: LeagueDetailPage,
});

const usersRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/users',
  component: UsersPage,
});

const auditRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/audit',
  component: AuditPage,
});

const routeTree = rootRoute.addChildren([
  signInRoute,
  authedRoute.addChildren([homeRoute, leaguesRoute, leagueDetailRoute, usersRoute, auditRoute]),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
