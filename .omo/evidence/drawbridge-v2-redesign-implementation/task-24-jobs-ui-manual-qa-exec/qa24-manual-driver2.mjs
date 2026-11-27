/**
 * Task 24 manual-QA focused driver 2 (clean-window verification).
 * Fresh tab; sign-in, one league, one real job row, then the exact claimed
 * SSE listener cycle: home (0) -> SPA to job queue (1) -> SPA home (0),
 * measured via GET /__qa/listeners (bounded polling for measurement only).
 * Also repeats the mobile table-scroll assertion with the correct scroll
 * container (.table-wrap) and captures qa-18/qa-19 screenshots.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));
const PANEL = 'http://127.0.0.1:5173';
const API = 'http://127.0.0.1:8080';
const GUILD_ID = '1573554616371777546';

const logLines = [];
function log(line) {
  const s = `[${new Date().toISOString()}] ${line}`;
  logLines.push(s);
  process.stdout.write(`${s}\n`);
}
function fail(name, detail) {
  log(`FAIL ${name}${detail ? ` :: ${detail}` : ''}`);
  process.exitCode = 1;
}
function pass(name, detail) {
  log(`PASS ${name}${detail ? ` :: ${detail}` : ''}`);
}
function assert(cond, name, detail) {
  if (cond) pass(name, detail);
  else fail(name, detail);
  return !!cond;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.waiters = [];
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const w of [...this.waiters]) {
          if (w.method === msg.method) {
            this.waiters.splice(this.waiters.indexOf(w), 1);
            w.resolve(msg.params);
          }
        }
      }
    });
    this.sessionId = null;
  }
  send(method, params = {}) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (this.sessionId) msg.sessionId = this.sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  waitForEvent(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const w = { method, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, timeoutMs);
    });
  }
}

async function connectCdp() {
  const version = await (await fetch('http://127.0.0.1:9333/json/version')).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const cdp = new Cdp(ws);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  cdp.sessionId = sessionId;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  return cdp;
}

const INSTALL = `(() => {
  if (window.__mq) return 'already';
  const csrf = () => {
    const m = document.cookie.match(/(?:^|; )drawbridge_csrf=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : undefined;
  };
  window.__mq = {
    api: async (path, init = {}) => {
      const method = (init.method ?? 'GET').toUpperCase();
      const headers = { ...(init.headers ?? {}) };
      if (init.body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
      if (['POST','PUT','PATCH','DELETE'].includes(method)) {
        const t = csrf();
        if (t) headers['x-csrf-token'] = t;
      }
      const r = await fetch(path, { ...init, method, headers, credentials: 'same-origin' });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    wait: (fn, ms) => new Promise((resolve, reject) => {
      const check = () => { let v; try { v = fn(); } catch (e) { return; } if (v) { cleanup(); resolve(v); } };
      const mo = new MutationObserver(check);
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const timer = setTimeout(() => { cleanup(); reject(new Error('wait timeout')); }, ms || 8000);
      const cleanup = () => { mo.disconnect(); clearTimeout(timer); };
      check();
    }),
  };
  return 'installed';
})()`;

async function evalJs(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
  return res.result?.value;
}
async function navigate(cdp, url) {
  const loaded = cdp.waitForEvent('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  await evalJs(cdp, INSTALL);
  log(`  navigated -> ${url}`);
}
async function waitFor(cdp, fnBody, name) {
  await evalJs(cdp, `window.__mq.wait(${fnBody})`);
  log(`  observed: ${name}`);
}
async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
  log(`  screenshot -> ${name}`);
}

async function listeners() {
  return (await (await fetch(`${API}/__qa/listeners`)).json()).listeners;
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

async function main() {
  log('=== driver 2: clean-window SSE listener cycle + mobile scroll (corrected selector) ===');
  const cdp = await connectCdp();
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  log('SC-A invocation: Page.navigate ' + PANEL + '/api/v1/auth/discord (fresh tab, real session/CSRF flow)');
  await navigate(cdp, `${PANEL}/api/v1/auth/discord`);
  await waitFor(cdp, `() => !!document.querySelector('[data-testid="needs-attention"]')`, 'home mounted');

  const league = await evalJs(
    cdp,
    `window.__mq.api('/api/v1/leagues').then((r) => (r.body.leagues[0] ? { created: false, league: r.body.leagues[0] } : window.__mq.api('/api/v1/leagues', { method: 'POST', body: JSON.stringify({ guildId: '${GUILD_ID}', citadelLeagueId: 9100, name: 'Listener QA League', shortcode: 'LQ24' }) }).then((c) => ({ created: true, league: c.body.league }))))`,
  );
  assert(!!league.league?.id, 'S2-league-available', `created=${league.created}`);
  const leagueId = league.league.id;
  const failed = await (await fetch(`${API}/__qa/failed-job?leagueId=${leagueId}`)).json();
  assert(failed.state === 'awaiting_decision', 'S6-queue-row-job', `state=${failed.state}`);

  // Clean-window cycle: home (0) -> SPA queue (1) -> SPA home (0).
  const l0 = await listenersUntil(0);
  assert(l0.value === 0, 'S4-clean-listeners-home-0', `listeners=${l0.value}`);
  await evalJs(cdp, `document.querySelector('a[href="/leagues"]').click()`);
  await waitFor(cdp, `() => !!document.querySelector('a[href="/leagues/${leagueId}"]')`, 'leagues list');
  await evalJs(cdp, `document.querySelector('a[href="/leagues/${leagueId}"]').click()`);
  await waitFor(cdp, `() => !!document.querySelector('a[href="/leagues/${leagueId}/jobs"]')`, 'league detail');
  await evalJs(cdp, `document.querySelector('a[href="/leagues/${leagueId}/jobs"]').click()`);
  await waitFor(cdp, `() => document.querySelector('[data-testid="job-stream-status"]')?.innerText === 'Live updates connected'`, 'queue stream live (SPA)');
  const l1 = await listenersUntil(1);
  assert(l1.value === 1, 'S4-clean-listeners-mounted-1', `listeners=${l1.value} waited=${l1.waitedMs}ms`);

  // Corrected mobile scroll assertion: the .table-wrap is the scroll container.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const scroll = await evalJs(cdp, `(() => { const t = document.querySelector('[data-testid="job-queue"]'); const w = t.parentElement; return { pageWidth: document.documentElement.scrollWidth, wrapScroll: w.scrollWidth, wrapClient: w.clientWidth }; })()`);
  assert(scroll.pageWidth === 390 && scroll.wrapScroll > scroll.wrapClient, 'S1-mobile-table-scrolls-in-wrapper', JSON.stringify(scroll));
  await shot(cdp, 'qa-18-queue-mobile-fixed.png');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  await evalJs(cdp, `document.querySelector('a[href="/"]').click()`);
  await waitFor(cdp, `() => !!document.querySelector('[data-testid="needs-attention"]')`, 'home mounted (SPA)');
  const l2 = await listenersUntil(0);
  assert(l2.value === 0, 'S4-clean-listeners-unmounted-0', `listeners=${l2.value} waited=${l2.waitedMs}ms`);
  await shot(cdp, 'qa-19-home-after-unmount.png');

  log(`result: listeners ${l0.value} -> ${l1.value} -> ${l2.value}`);
  writeFileSync(join(OUT, 'qa-driver2-actions.log'), logLines.join('\n') + '\n');
  log('=== driver 2 complete ===');
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
}

main().catch((e) => {
  log(`DRIVER2 ERROR :: ${e.stack ?? e}`);
  writeFileSync(join(OUT, 'qa-driver2-actions.log'), logLines.join('\n') + '\n');
  setTimeout(() => process.exit(1), 500);
});
