import { describe, expect, it, vi } from 'vitest';
import { createDiscordOAuth, OAuthError } from '../src/auth/oauth.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function oauth(fetchImpl: typeof fetch) {
  return createDiscordOAuth({
    clientId: 'app-1',
    clientSecret: 'secret-1',
    redirectUri: 'http://localhost:8080/api/v1/auth/discord/callback',
    fetchImpl,
  });
}

describe('discord oauth', () => {
  it('builds an authorize URL with identify scope and state', () => {
    const url = new URL(oauth(fetch).authorizeUrl('state-123'));
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('app-1');
    expect(url.searchParams.get('scope')).toBe('identify');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:8080/api/v1/auth/discord/callback',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('exchanges a code with client credentials and the redirect URI', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ access_token: 'token-abc', token_type: 'Bearer' });
    }) as unknown as typeof fetch;

    const token = await oauth(fetchImpl).exchangeCode('code-xyz');
    expect(token).toBe('token-abc');
    expect(calls[0]?.url).toBe('https://discord.com/api/oauth2/token');
    const body = String(calls[0]?.init?.body);
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=code-xyz');
    expect(body).toContain(
      encodeURIComponent('http://localhost:8080/api/v1/auth/discord/callback').replace(
        /%2F/g,
        '%2F',
      ),
    );
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe(
      `Basic ${Buffer.from('app-1:secret-1').toString('base64')}`,
    );
  });

  it('rejects a failed exchange', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'invalid_grant' }, 400),
    ) as unknown as typeof fetch;
    await expect(oauth(fetchImpl).exchangeCode('bad')).rejects.toMatchObject({
      code: 'exchange_failed',
    });
  });

  it('fetches the Discord user with the bearer token', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://discord.com/api/users/@me');
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers['authorization']).toBe('Bearer token-abc');
      return jsonResponse({
        id: '1573554616371777546',
        username: 'natha',
        global_name: 'Natha',
        avatar: 'abc',
      });
    }) as unknown as typeof fetch;

    const user = await oauth(fetchImpl).fetchUser('token-abc');
    expect(user).toEqual({
      id: '1573554616371777546',
      username: 'natha',
      globalName: 'Natha',
      avatar: 'abc',
    });
  });

  it('rejects an incomplete user payload', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: '1' })) as unknown as typeof fetch;
    await expect(oauth(fetchImpl).fetchUser('t')).rejects.toBeInstanceOf(OAuthError);
  });
});
