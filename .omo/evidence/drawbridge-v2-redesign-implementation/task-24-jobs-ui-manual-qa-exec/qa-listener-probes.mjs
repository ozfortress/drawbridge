/**
 * Direct-socket SSE disconnect probes against the real buildApp on 8080
 * (NO proxy in the path). Verifies the stream route releases its Postgres
 * listener promptly when a client socket is destroyed abruptly, including
 * the destroy-during-acquisition race the todo-24 fix addresses.
 *
 * Writes qa-listener-probes.log. Measurement polling is bounded (100ms tick,
 * 5s deadline) and only measures the listener count endpoint.
 */
import { request as httpRequest } from 'node:http';

const API = 'http://127.0.0.1:8080';
const lines = [];
function log(line) {
  const s = `[${new Date().toISOString()}] ${line}`;
  lines.push(s);
  process.stdout.write(`${s}\n`);
}
function fail(name, detail) {
  log(`FAIL ${name} :: ${detail}`);
  process.exitCode = 1;
}
function pass(name, detail) {
  log(`PASS ${name} :: ${detail}`);
}

async function listeners() {
  const r = await fetch(`${API}/__qa/listeners`);
  return (await r.json()).listeners;
}
async function listenersUntil(target, timeoutMs = 5000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await listeners();
    if (last === target) return { value: last, waitedMs: Date.now() - start };
    await new Promise((r) => setTimeout(r, 100));
  }
  return { value: last, waitedMs: Date.now() - start };
}

function openStream(cookie, leagueId, { destroyAtOnce = false, destroyOnFirstByte = false } = {}) {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: 8080,
        path: `/api/v1/stream?leagueId=${leagueId}`,
        headers: { cookie, accept: 'text/event-stream' },
      },
      (res) => {
        res.once('data', () => {
          if (destroyOnFirstByte) req.destroy();
        });
        res.on('error', () => undefined);
        resolve({ req, res, status: res.statusCode });
      },
    );
    req.on('error', () => undefined);
    req.end();
    if (destroyAtOnce) {
      // Abort during connection setup / listener acquisition.
      setImmediate(() => req.destroy());
      resolve({ req, res: null, status: 0 });
    }
  });
}

async function main() {
  log('=== direct-socket SSE disconnect probes (buildApp :8080, no proxy) ===');

  // Sign in through the real session flow (fake OAuth callback).
  const authRes = await fetch(`${API}/api/v1/auth/discord`, { redirect: 'manual' });
  const state = new URL(authRes.headers.get('location'), API).searchParams.get('state');
  const authCookies = (authRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const cbRes = await fetch(
    `${API}/api/v1/auth/discord/callback?code=qa&state=${encodeURIComponent(state)}`,
    { redirect: 'manual', headers: { cookie: authCookies } },
  );
  const setCookies = [
    ...(cbRes.headers.getSetCookie?.() ?? []),
  ];
  log(`set-cookie names: ${setCookies.map((c) => c.split(';')[0].split('=')[0]).join(', ')}`);
  const session = setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('drawbridge_session='));
  if (!session) throw new Error(`no session cookie: ${setCookies.length} set-cookie headers`);
  log('signed in through real session flow (fake OAuth)');

  const csrf = setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('drawbridge_csrf='));
  const authHeaders = { cookie: `${session}; ${csrf.split(';')[0]}`, 'x-csrf-token': decodeURIComponent(csrf.split('=').slice(1).join('=')) };
  let leagues = await (await fetch(`${API}/api/v1/leagues`, { headers: { cookie: session } })).json();
  let leagueId = leagues.leagues[0]?.id;
  if (!leagueId) {
    const created = await fetch(`${API}/api/v1/leagues`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ guildId: '1573554616371777546', citadelLeagueId: 9100, name: 'Probe League', shortcode: 'PB24' }),
    });
    const createdBody = await created.json();
    log(`league create status=${created.status} body=${JSON.stringify(createdBody).slice(0, 160)}`);
    leagueId = createdBody.league?.id;
  }
  if (!leagueId) throw new Error('no league visible');
  log(`league under test: ${leagueId}`);

  // Control: two concurrent streams -> 2 listeners -> both destroyed -> 0.
  let base = (await listenersUntil(0)).value;
  if (base !== 0) fail('probe-baseline-0', `listeners=${base}`);
  else pass('probe-baseline-0', 'listeners=0');

  const a = await openStream(session, leagueId);
  const b = await openStream(session, leagueId);
  const two = await listenersUntil(2);
  if (two.value === 2) pass('probe-two-streams-2', `waited=${two.waitedMs}ms`);
  else fail('probe-two-streams-2', `listeners=${two.value}`);
  a.req.destroy();
  b.req.destroy();
  const zero = await listenersUntil(0);
  if (zero.value === 0) pass('probe-destroy-releases', `back to 0 in ${zero.waitedMs}ms`);
  else fail('probe-destroy-releases', `listeners=${zero.value} after 5s`);

  // Abrupt destroy right after first byte (post-acquisition disconnect).
  for (let i = 1; i <= 3; i++) {
    await listenersUntil(0);
    await openStream(session, leagueId, { destroyOnFirstByte: true });
    const r = await listenersUntil(0);
    if (r.value === 0) pass(`probe-post-acquire-destroy-${i}`, `released in ${r.waitedMs}ms`);
    else fail(`probe-post-acquire-destroy-${i}`, `listeners=${r.value} after 5s`);
  }

  // Destroy during listener acquisition (the disconnect race).
  for (let i = 1; i <= 5; i++) {
    await listenersUntil(0);
    await openStream(session, leagueId, { destroyAtOnce: true });
    const r = await listenersUntil(0);
    if (r.value === 0) pass(`probe-acquire-race-destroy-${i}`, `released in ${r.waitedMs}ms`);
    else fail(`probe-acquire-race-destroy-${i}`, `listeners=${r.value} after 5s`);
  }

  log('=== probes complete ===');
  process.stdout.write('');
  const { writeFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'qa-listener-probes.log'), lines.join('\n') + '\n');
  process.exitCode = process.exitCode ?? 0;
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500);
}

main().catch((e) => {
  log(`PROBE ERROR :: ${e.stack ?? e}`);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 1500);
});
