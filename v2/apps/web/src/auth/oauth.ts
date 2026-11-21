/**
 * Discord OAuth2 (authorization code flow) and user lookup.
 *
 * The HTTP calls are injected (`fetchImpl`) so tests never touch the network.
 */
export class OAuthError extends Error {
  override readonly name = 'OAuthError';
  readonly code: 'exchange_failed' | 'user_failed';

  constructor(code: OAuthError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface DiscordUser {
  id: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
}

export interface DiscordOAuth {
  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<string>;
  fetchUser(accessToken: string): Promise<DiscordUser>;
}

export interface DiscordOAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  apiBaseUrl?: string;
}

export function createDiscordOAuth(options: DiscordOAuthOptions): DiscordOAuth {
  const fetchImpl = options.fetchImpl ?? fetch;
  const authorizationEndpoint =
    options.authorizationEndpoint ?? 'https://discord.com/oauth2/authorize';
  const tokenEndpoint = options.tokenEndpoint ?? 'https://discord.com/api/oauth2/token';
  const apiBaseUrl = options.apiBaseUrl ?? 'https://discord.com/api';

  return {
    authorizeUrl(state: string): string {
      const url = new URL(authorizationEndpoint);
      url.searchParams.set('client_id', options.clientId);
      url.searchParams.set('redirect_uri', options.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'identify');
      url.searchParams.set('state', state);
      return url.toString();
    },

    async exchangeCode(code: string): Promise<string> {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: options.redirectUri,
      });
      const response = await fetchImpl(tokenEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64')}`,
        },
        body: body.toString(),
      });
      if (!response.ok) {
        throw new OAuthError('exchange_failed', `token exchange failed with ${response.status}`);
      }
      const payload = (await response.json()) as { access_token?: string };
      if (!payload.access_token) {
        throw new OAuthError('exchange_failed', 'token exchange returned no access token');
      }
      return payload.access_token;
    },

    async fetchUser(accessToken: string): Promise<DiscordUser> {
      const response = await fetchImpl(`${apiBaseUrl}/users/@me`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        throw new OAuthError('user_failed', `user lookup failed with ${response.status}`);
      }
      const payload = (await response.json()) as {
        id?: string;
        username?: string;
        global_name?: string | null;
        avatar?: string | null;
      };
      if (!payload.id || !payload.username) {
        throw new OAuthError('user_failed', 'user lookup returned an incomplete user');
      }
      return {
        id: payload.id,
        username: payload.username,
        globalName: payload.global_name ?? null,
        avatar: payload.avatar ?? null,
      };
    },
  };
}
