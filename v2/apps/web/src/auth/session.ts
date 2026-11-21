import type { GlobalTier } from '@drawbridge/authz';
import { hashToken, randomToken, safeEqual } from '@drawbridge/crypto';
import type { Db } from '@drawbridge/db';
import { findUserById, findValidSession } from '@drawbridge/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, unauthorized } from '../http/errors.js';

export const SESSION_COOKIE = 'drawbridge_session';
export const SESSION_COOKIE_SECURE = '__Host-drawbridge_session';
export const CSRF_COOKIE = 'drawbridge_csrf';
export const OAUTH_STATE_COOKIE = 'drawbridge_oauth_state';

const CSRF_HEADER = 'x-csrf-token';

export function useSecureCookies(publicBaseUrl: string): boolean {
  return publicBaseUrl.startsWith('https://');
}

export function sessionCookieName(secure: boolean): string {
  // `__Host-` requires Secure, Path=/ and no Domain. It is the strongest form,
  // but browsers only accept it over HTTPS (including localhost in some cases),
  // so plain-http development uses a normal cookie name.
  return secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE;
}

interface CookieOptions {
  httpOnly: boolean;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge?: number;
}

function cookieOptions(secure: boolean, httpOnly: boolean, maxAgeSeconds?: number): CookieOptions {
  return {
    httpOnly,
    sameSite: 'lax',
    secure,
    path: '/',
    ...(maxAgeSeconds !== undefined ? { maxAge: maxAgeSeconds } : {}),
  };
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie(
    sessionCookieName(secure),
    token,
    cookieOptions(secure, true, Math.floor((7 * 24 * 60 * 60 * 1000) / 1000)),
  );
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(sessionCookieName(secure), cookieOptions(secure, true));
}

export function readSessionToken(request: FastifyRequest, secure: boolean): string | undefined {
  return request.cookies[sessionCookieName(secure)];
}

export function issueCsrfToken(): string {
  return randomToken(24);
}

export function setCsrfCookie(reply: FastifyReply, token: string, secure: boolean): void {
  // Readable by the panel so it can echo the token in a header.
  reply.setCookie(CSRF_COOKIE, token, cookieOptions(secure, false));
}

export function setOAuthStateCookie(reply: FastifyReply, state: string, secure: boolean): void {
  reply.setCookie(
    OAUTH_STATE_COOKIE,
    state,
    cookieOptions(secure, true, Math.floor((10 * 60 * 1000) / 1000)),
  );
}

export function readOAuthState(request: FastifyRequest): string | undefined {
  return request.cookies[OAUTH_STATE_COOKIE];
}

export function clearOAuthState(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(OAUTH_STATE_COOKIE, cookieOptions(secure, true));
}

/** Double-submit CSRF check for state-changing requests. */
export function requireCsrf(request: FastifyRequest): void {
  const cookie = request.cookies[CSRF_COOKIE];
  const header = request.headers[CSRF_HEADER];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!cookie || !provided || !safeEqual(cookie, provided)) {
    throw forbidden('CSRF token missing or invalid. Reload the page and try again.');
  }
}

export interface AuthContext {
  userId: string;
  discordId: string;
  displayName: string;
  tier: GlobalTier;
  status: 'active' | 'invited' | 'disabled';
}

/** Resolves the session cookie to an active user. */
export async function authenticate(
  db: Db,
  request: FastifyRequest,
  secure: boolean,
): Promise<AuthContext | undefined> {
  const token = readSessionToken(request, secure);
  if (!token) return undefined;
  const session = await findValidSession(db, hashToken(token));
  if (!session) return undefined;
  const user = await findUserById(db, session.userId);
  if (!user || user.status === 'disabled') return undefined;
  return {
    userId: user.id,
    discordId: user.discordId,
    displayName: user.displayName,
    tier: user.globalRole as GlobalTier,
    status: user.status as AuthContext['status'],
  };
}

export async function requireAuth(
  db: Db,
  request: FastifyRequest,
  secure: boolean,
): Promise<AuthContext> {
  const auth = await authenticate(db, request, secure);
  if (!auth) throw unauthorized();
  request.auth = auth;
  return auth;
}
