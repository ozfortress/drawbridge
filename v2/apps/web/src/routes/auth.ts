import { tierCapabilities } from '@drawbridge/authz';
import type { Config } from '@drawbridge/config';
import { hashToken, randomToken, safeEqual } from '@drawbridge/crypto';
import type { Db } from '@drawbridge/db';
import {
  consumeInvite,
  createSession,
  findUserById,
  revokeSession,
  upsertDiscordUser,
} from '@drawbridge/db';
import type { Logger } from '@drawbridge/logging';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DiscordOAuth } from '../auth/oauth.js';
import {
  clearOAuthState,
  clearSessionCookie,
  issueCsrfToken,
  readOAuthState,
  readSessionToken,
  requireAuth,
  setCsrfCookie,
  setOAuthStateCookie,
  setSessionCookie,
  useSecureCookies,
} from '../auth/session.js';
import { HttpError } from '../http/errors.js';
import { parseQuery } from '../http/helpers.js';

export interface AuthRouteDeps {
  config: Config;
  db: Db;
  oauth: DiscordOAuth;
  logger: Logger;
}

const callbackQuery = z.object({ code: z.string().min(1), state: z.string().min(1) });

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const secure = useSecureCookies(deps.config.publicBaseUrl);
  const logger = deps.logger.child({ scope: 'auth' });

  app.get('/api/v1/auth/discord', async (_request, reply) => {
    const state = randomToken(24);
    setOAuthStateCookie(reply, state, secure);
    return reply.redirect(deps.oauth.authorizeUrl(state));
  });

  app.get('/api/v1/auth/discord/callback', async (request, reply) => {
    let code: string;
    let state: string;
    try {
      const query = parseQuery(callbackQuery, request);
      code = query.code;
      state = query.state;
    } catch (error) {
      const message = error instanceof HttpError ? error.userMessage : 'invalid callback';
      logger.warn('oauth callback rejected', { reason: message });
      return reply.redirect('/signin?error=callback');
    }

    const expected = readOAuthState(request);
    clearOAuthState(reply, secure);
    if (!expected || !safeEqual(expected, state)) {
      logger.warn('oauth state mismatch');
      return reply.redirect('/signin?error=state');
    }

    try {
      const accessToken = await deps.oauth.exchangeCode(code);
      const discordUser = await deps.oauth.fetchUser(accessToken);

      const user = await upsertDiscordUser(deps.db, {
        discordId: discordUser.id,
        displayName: discordUser.globalName ?? discordUser.username,
        avatarHash: discordUser.avatar,
      });
      if (user.status === 'disabled') {
        logger.warn('disabled user attempted sign-in', { userId: user.id });
        return reply.redirect('/signin?error=disabled');
      }

      await consumeInvite(deps.db, user);
      const refreshed = (await findUserById(deps.db, user.id)) ?? user;

      const token = randomToken();
      await createSession(deps.db, refreshed.id, hashToken(token));
      setSessionCookie(reply, token, secure);
      const csrf = issueCsrfToken();
      setCsrfCookie(reply, csrf, secure);

      logger.info('signed in', { userId: refreshed.id, tier: refreshed.globalRole });
      return reply.redirect('/');
    } catch (error) {
      logger.error('oauth sign-in failed', { error });
      return reply.redirect('/signin?error=oauth');
    }
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    const token = readSessionToken(request, secure);
    if (token) await revokeSession(deps.db, hashToken(token));
    clearSessionCookie(reply, secure);
    logger.info('signed out', { userId: auth.userId });
    return reply.status(204).send();
  });

  app.get('/api/v1/me', async (request, reply) => {
    const auth = await requireAuth(deps.db, request, secure);
    // The panel needs a CSRF token for its mutating requests.
    const csrf = request.cookies['drawbridge_csrf'] ?? issueCsrfToken();
    setCsrfCookie(reply, csrf, secure);
    const user = await findUserById(deps.db, auth.userId);
    return reply.send({
      user: {
        id: auth.userId,
        discordId: auth.discordId,
        displayName: auth.displayName,
        tier: auth.tier,
        status: auth.status,
      },
      csrfToken: csrf,
      globalCapabilities: [...tierCapabilities(auth.tier)].sort(),
      lastLoginAt: user?.lastLoginAt?.toISOString() ?? null,
    });
  });
}
