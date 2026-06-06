"""Discord OAuth2 authentication and JWT session management for admin panel."""

import os
import time
import json
import urllib.request
import urllib.parse
import hashlib
import hmac
import base64
import logging

logger = logging.getLogger('drawbridge.web.admin_auth')


def _base64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def _base64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + '===')


def _create_jwt(payload: dict, secret: str) -> str:
    header = {'alg': 'HS256', 'typ': 'JWT'}
    header_b64 = _base64url_encode(json.dumps(header, separators=(',', ':')).encode())
    payload_b64 = _base64url_encode(json.dumps(payload, separators=(',', ':')).encode())
    signing_input = f'{header_b64}.{payload_b64}'
    sig = hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    return f'{signing_input}.{_base64url_encode(sig)}'


def _verify_jwt(token: str, secret: str) -> dict | None:
    try:
        parts = token.split('.')
        if len(parts) != 3:
            return None
        header_b64, payload_b64, sig_b64 = parts
        signing_input = f'{header_b64}.{payload_b64}'
        expected_sig = hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
        actual_sig = _base64url_decode(sig_b64)
        if not hmac.compare_digest(expected_sig, actual_sig):
            return None
        payload = json.loads(_base64url_decode(payload_b64))
        if payload.get('exp', 0) < time.time():
            return None
        return payload
    except Exception:
        return None


def create_session(user_id: int, username: str, avatar: str, is_admin: bool) -> str:
    secret = os.getenv('SESSION_SECRET', '')
    if not secret:
        raise RuntimeError('SESSION_SECRET not set')
    payload = {
        'sub': str(user_id),
        'username': username,
        'avatar': avatar,
        'is_admin': is_admin,
        'iat': int(time.time()),
        'exp': int(time.time()) + 900
    }
    return _create_jwt(payload, secret)


def verify_session(token: str) -> dict | None:
    secret = os.getenv('SESSION_SECRET', '')
    if not secret:
        return None
    return _verify_jwt(token, secret)


# Discord OAuth2 helpers
DISCORD_API_BASE = 'https://discord.com/api'

def get_oauth2_url() -> str:
    client_id = os.getenv('DISCORD_CLIENT_ID', '')
    redirect_uri = os.getenv('DISCORD_REDIRECT_URI', '')
    params = urllib.parse.urlencode({
        'client_id': client_id,
        'redirect_uri': redirect_uri,
        'response_type': 'code',
        'scope': 'identify guilds guilds.members.read'
    })
    return f'{DISCORD_API_BASE}/oauth2/authorize?{params}'


def exchange_code(code: str) -> dict | None:
    client_id = os.getenv('DISCORD_CLIENT_ID', '')
    client_secret = os.getenv('DISCORD_CLIENT_SECRET', '')
    redirect_uri = os.getenv('DISCORD_REDIRECT_URI', '')
    data = urllib.parse.urlencode({
        'client_id': client_id,
        'client_secret': client_secret,
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': redirect_uri,
    }).encode()
    req = urllib.request.Request(
        f'{DISCORD_API_BASE}/oauth2/token',
        data=data,
        headers={'Content-Type': 'application/x-www-form-urlencoded'},
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception as e:
        logger.error(f'OAuth2 token exchange failed: {e}')
        return None


def fetch_discord_user(access_token: str) -> dict | None:
    req = urllib.request.Request(
        f'{DISCORD_API_BASE}/users/@me',
        headers={'Authorization': f'Bearer {access_token}'}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception as e:
        logger.error(f'Failed to fetch Discord user: {e}')
        return None
