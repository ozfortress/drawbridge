/**
 * Task 24 manual-QA browser driver (independent verification run).
 * Drives Chrome headless through the native DevTools Protocol against the
 * production panel build served by `vite preview` (127.0.0.1:5173) with the
 * real buildApp behind it (127.0.0.1:8080), real Postgres 5433, fake OAuth
 * and FakeCitadel. HTTP API probes use `curl -i` exactly as logged.
 *
 * Writes: qa-manual-actions.log (invocation + verdict lines),
 * qa-manual-facts.json, qa-*.png screenshots, qa-curl-*.txt curl transcripts.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));
const PANEL = 'http://127.0.0.1:5173';
const API = 'http://127.0.0.1:8080';
const GUILD_ID = '1573554616371777546';

mkdirSync(OUT, { recursive: true });
const logLines = [];
const facts = {};
function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  logLines.push(stamped);
  process.stdout.write(`${stamped}\n`);
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

// ---------- minimal CDP client ----------
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
  let version;
  for (let i = 0; i < 40; i++) {
    try {
      version = await (await fetch('http://127.0.0.1:9333/json/version')).json();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!version) throw new Error('chrome devtools endpoint never came up');
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
    facts: () => ({
      url: location.href,
      state: document.querySelector('[data-testid="job-state"]')?.dataset.state ?? null,
      decisions: [...document.querySelectorAll('[data-testid^="decision-"]')].map((b) => ({ id: b.getAttribute('data-testid'), disabled: b.disabled })),
      stepCount: document.querySelectorAll('[data-testid="job-step"]').length,
      doneSteps: [...document.querySelectorAll('[data-testid="job-step"] .pill')].filter((p) => p.textContent.trim() === 'done').length,
      eventCount: document.querySelectorAll('[data-testid="job-event"]').length,
      testids: [...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')),
    }),
  };
  return 'installed';
})()`;

async function evalJs(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
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

function waitExpr(fnBody) {
  return `window.__mq.wait(${fnBody})`;
}

async function waitFor(cdp, fnBody, name) {
  await evalJs(cdp, waitExpr(fnBody));
  log(`  observed: ${name}`);
}

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
  log(`  screenshot -> ${name}`);
}

async function setViewport(cdp, width, height, mobile) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
}

// ---------- curl probes (faithful HTTP channel) ----------
function redact(s) {
  return s.replace(/(drawbridge_session=)[^;\s"]+/g, '$1[redacted]').replace(/(drawbridge_csrf=)[^;\s"]+/g, '$1[redacted]').replace(/(x-csrf-token: )[^\s"]+/gi, '$1[redacted]');
}
function curl(name, args, cookies) {
  const cookieHeader = cookies ? `Cookie: drawbridge_session=${cookies.session}; drawbridge_csrf=${cookies.csrf}` : null;
  const full = ['curl', '-i', '-s', ...args];
  if (cookieHeader) full.push('-H', cookieHeader);
  log(`  invocation: ${redact(full.join(' '))}`);
  const out = execFileSync('curl', ['-i', '-s', ...args, ...(cookieHeader ? ['-H', cookieHeader] : [])], {
    encoding: 'utf8',
  });
  writeFileSync(join(OUT, `qa-curl-${name}.txt`), redact(out));
  const statusLine = out.split('\r\n')[0] ?? '';
  log(`  curl ${name} -> ${statusLine}`);
  return out;
}
function statusOf(raw) {
  const m = raw.match(/^HTTP\/\d(?:\.\d)? (\d{3})/);
  return m ? Number(m[1]) : 0;
}
function bodyOf(raw) {
  const i = raw.indexOf('\r\n\r\n');
  return i >= 0 ? raw.slice(i + 4) : '';
}

// ---------- listener polling (measurement only) ----------
async function listeners() {
  const r = await fetch(`${API}/__qa/listeners`);
  return (await r.json()).listeners;
}
async function listenersUntil(target, timeoutMs = 5000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await listeners();
    if (last === target) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  return last;
}

async function qaPost(path, body) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return r.json();
}
async function qaGet(path) {
  const r = await fetch(`${API}${path}`);
  return r.json();
}

// ================= scenarios =================
async function main() {
  log('=== Task 24 manual QA driver ===');
  log(`surface: production Vite panel on ${PANEL} (vite preview) -> real buildApp on ${API}; Chrome headless via native DevTools Protocol on 127.0.0.1:9333; real Postgres 5433; fake OAuth + FakeCitadel`);
  const cdp = await connectCdp();
  await setViewport(cdp, 1440, 1000, false);

  // SC1: sign-in through the real session/CSRF flow + empty dashboard.
  log('SC1 invocation: Page.navigate ' + PANEL + '/api/v1/auth/discord (real session/CSRF flow, fake OAuth)');
  await navigate(cdp, `${PANEL}/api/v1/auth/discord`);
  await waitFor(cdp, `() => !!document.querySelector('[data-testid="needs-attention"]')`, 'home dashboard mounted');
  const homeEmpty = await evalJs(cdp, `document.querySelector('[data-testid="needs-attention"]').innerText`);
  assert(homeEmpty.includes('No jobs are waiting for a decision.'), 'S5-home-empty-awaiting', homeEmpty.slice(0, 80));
  assert(homeEmpty.includes('No open alerts.'), 'S5-home-empty-alerts');
  const recentEmpty = await evalJs(cdp, `document.body.innerText.includes('No jobs have been created in your leagues yet.')`);
  assert(recentEmpty, 'S5-home-empty-jobs');
  const leaguesEmpty = await evalJs(cdp, `!!document.querySelector('[data-testid="dashboard-leagues-empty"]')`);
  assert(leaguesEmpty, 'S5-home-empty-leagues');
  await shot(cdp, 'qa-01-home-empty.png');
  const cookieRes = await cdp.send('Network.getCookies', { urls: [PANEL] });
  const cookies = Object.fromEntries(cookieRes.cookies.map((c) => [c.name, c.value]));
  assert(!!cookies.drawbridge_session && !!cookies.drawbridge_csrf, 'S1-session-cookies', 'session + csrf cookies set');
  const authCookies = { session: cookies.drawbridge_session, csrf: cookies.drawbridge_csrf };

  // SC2: create league through the real API, empty queue state.
  log('SC2 invocation: in-page fetch POST /api/v1/leagues + PUT /api/v1/leagues/:id/citadel-key (real API, session+CSRF)');
  const created = await evalJs(
    cdp,
    `window.__mq.api('/api/v1/leagues', { method: 'POST', body: JSON.stringify({ guildId: '${GUILD_ID}', citadelLeagueId: 9100, name: 'Manual QA League', shortcode: 'MQ24' }) }).then(async (r) => ({ create: r, key: await window.__mq.api('/api/v1/leagues/' + r.body.league.id + '/citadel-key', { method: 'PUT', body: JSON.stringify({ key: 'manual-qa-key', label: 'manual qa' }) }) }))`,
  );
  const leagueId = created.create.body.league.id;
  assert(created.create.status === 201 && created.key.status === 200 && created.key.body.status === 'active', 'S2-league-and-key', `leagueId=${leagueId} key=${created.key.body.status}`);
  facts.leagueId = leagueId;
  log(`SC2 invocation: Page.navigate ${PANEL}/leagues/${leagueId}/jobs`);
  await navigate(cdp, `${PANEL}/leagues/${leagueId}/jobs`);
  await waitFor(cdp, `() => !!document.querySelector('[data-testid="job-queue-empty"]')`, 'queue empty state');
  const emptyText = await evalJs(cdp, `document.querySelector('[data-testid="job-queue-empty"]').innerText`);
  assert(emptyText.includes('No jobs have been created for this league yet.'), 'S5-queue-empty', emptyText);
  const streamText = await evalJs(cdp, `document.querySelector('[data-testid="job-stream-status"]').innerText`);
  assert(streamText === 'Live updates connected', 'S4-stream-status', streamText);
  await shot(cdp, 'qa-02-queue-empty.png');

  // SC3: loading state (queue) via loopback latency control.
  log('SC3 invocation: POST __qa/slow {ms:1500}; Page.navigate queue; observe [data-testid="job-queue-loading"]');
  await qaPost('/__qa/slow', { ms: 1500 });
  await navigate(cdp, `${PANEL}/leagues/${leagueId}/jobs`);
  await waitFor(cdp, `() => !!document.querySelector('[data-testid="job-queue-loading"]')`, 'queue loading state');
  await shot(cdp, 'qa-03-queue-loading.png');
  await qaPost('/__qa/slow', { ms: 0 });
  await waitFor(cdp, `() => !!document.querySelector('[data-testid="job-queue-empty"]')`, 'queue settled');

  // SC4: error state (queue) via loopback failure control.
  log('SC4 invocation: POST __qa/api-fail {match:"jobs"}; Page.navigate queue; observe [data-testid="job-queue-error"]');
  await qaPost('/__qa/api-fail', { match: 'jobs' });
  await navigate(cdp, `${PANEL}/leagues/${leagueId}/jobs`);
  await waitFor(cdp, `() => !!document.querySelector('[data-testid="job-queue-error"]')`, 'queue error state');
  const errText = await evalJs(cdp, `document.querySelector('[data-testid="job-queue-error"]').innerText`);
  assert(errText.length > 0, 'S5-queue-error', errText.slice(0, 80));
  await shot(cdp, 'qa-04-queue-error.png');
  await qaPost('/__qa/api-fail', { off: true });

  // SC5: build + approve a preview through the panel -> queued job detail.
  log(`SC5 invocation: Page.navigate ${PANEL}/leagues/${leagueId}/setup; click [data-testid="preview-button"]; click [data-testid="approve-preview"]`);
  await navigate(cdp, `${PANEL}/leagues/${leagueId}/setup`);
  await waitFor(cdp, `() => !!document.querySelector('[data-testid="preview-button"]')`, 'setup page');
  await evalJs(cdp, `document.querySelector('[data-testid="preview-button"]').click()`);
  await waitFor(cdp, `() => !!document.querySelector('[data-testid="preview-counts"]')`, 'preview built');
  const counts = await evalJs(cdp, `document.querySelector('[data-testid="preview-counts"]').innerText`);
  facts.previewCounts = counts.replace(/\n/g, ' | ');
  log(`  preview counts: ${facts.previewCounts}`);
  await evalJs(cdp, `document.querySelector('[data-testid="approve-preview"]').click()`);
  await waitFor(cdp, `() => /^\\/jobs\\/.+/.test(location.pathname) && !!document.querySelector('[data-testid="job-detail-page"]')`, 'approve navigated to job detail');
  const jobId = await evalJs(cdp, `location.pathname.split('/')[2]`);
  facts.approvedJobId = jobId;
  let f = await evalJs(cdp, `window.__mq.facts()`);
  assert(f.state === 'queued', 'S2-detail-state-queued', f.state);
  assert(f.stepCount === 32, 'S2-detail-steps-32', `steps=${f.stepCount}`);
  assert(JSON.stringify(f.decisions.map((d) => d.id)) === JSON.stringify(['decision-abort']), 'S3-queued-decisions-abort-only', JSON.stringify(f.decisions));
  for (const id of ['job-detail-page', 'job-metadata', 'job-decisions', 'job-steps', 'job-events', 'job-stream-status', 'detail-queue-link']) {
    assert(f.testids.includes(id), `S8-testid-${id}`);
  }
  await shot(cdp, 'qa-05-job-queued.png');

  // SC6: live running -> completed without refresh (REQUIRED claim).
  log('SC6 invocation: set window marker; POST __qa/job-state running then completed (real DB trigger -> LISTEN/NOTIFY -> SSE -> React Query); observe [data-testid="job-state"]');
  await evalJs(cdp, `window.__mq_marker = 'mq-live-1'; 'set'`);
  let t0 = Date.now();
  await qaPost('/__qa/job-state', { jobId, state: 'running' });
  await waitFor(cdp, `() => document.querySelector('[data-testid="job-state"]')?.dataset.state === 'running'`, 'running painted live');
  const runningMs = Date.now() - t0;
  t0 = Date.now();
  await qaPost('/__qa/job-state', { jobId, state: 'completed' });
  await waitFor(cdp, `() => document.querySelector('[data-testid="job-state"]')?.dataset.state === 'completed'`, 'completed painted live');
  const completedMs = Date.now() - t0;
  const marker = await evalJs(cdp, `window.__mq_marker`);
  assert(marker === 'mq-live-1', 'S4-no-refresh-marker-survived', `marker=${marker}`);
  await waitFor(cdp, `() => !!document.querySelector('[data-testid="job-decisions-empty"]')`, 'terminal decisions settle');
  f = await evalJs(cdp, `window.__mq.facts()`);
  assert(f.state === 'completed' && f.doneSteps === 32, 'S2-completed-32-done', `state=${f.state} done=${f.doneSteps}`);
  const noDecText = await evalJs(cdp, `document.querySelector('[data-testid="job-decisions-empty"]').innerText`);
  assert(noDecText.includes('No decisions are available for this job state or your access.'), 'S3-terminal-no-decisions', noDecText);
  facts.liveUpdateMs = { running: runningMs, completed: completedMs };
  log(`  live timings: running=${runningMs}ms completed=${completedMs}ms`);
  await shot(cdp, 'qa-06-job-completed.png');

  // SC7: queue columns and links (desktop + mobile).
  log('SC7 invocation: click [data-testid="detail-queue-link"] (SPA); assert queue table headers and row');
  await evalJs(cdp, `document.querySelector('[data-testid="detail-queue-link"]').click()`);
  await waitFor(cdp, `() => !!document.querySelector('[data-testid="job-queue"]')`, 'queue rendered');
  const headers = await evalJs(cdp, `[...document.querySelectorAll('[data-testid="job-queue"] thead th')].map((t) => t.textContent.trim())`);
  assert(JSON.stringify(headers) === JSON.stringify(['State', 'Type', 'League', 'Requested by', 'Updated']), 'S1-queue-columns', JSON.stringify(headers));
  const rowState = await evalJs(cdp, `document.querySelector('[data-testid="job-queue"] tbody tr')?.dataset.state`);
  assert(rowState === 'completed', 'S1-queue-row-state', rowState);
  const stream2 = await evalJs(cdp, `document.querySelector('[data-testid="job-stream-status"]').innerText`);
  assert(stream2 === 'Live updates connected', 'S1-queue-stream-status', stream2);
  await shot(cdp, 'qa-07-queue-desktop.png');
  await setViewport(cdp, 390, 844, true);
  const mobileWidth = await evalJs(cdp, `document.documentElement.scrollWidth`);
  assert(mobileWidth === 390, 'S1-queue-mobile-width', `scrollWidth=${mobileWidth}`);
  const tableScroll = await evalJs(cdp, `(() => { const t = document.querySelector('[data-testid="job-queue"]'); return { sw: t.scrollWidth, cw: t.clientWidth }; })()`);
  assert(tableScroll.sw > tableScroll.cw, 'S1-queue-mobile-table-scrolls', JSON.stringify(tableScroll));
  await shot(cdp, 'qa-08-queue-mobile.png');
  await setViewport(cdp, 1440, 1000, false);

  // SC8: reopen detail through its queue link.
  log('SC8 invocation: click [data-testid="job-open"] (SPA) -> reopened detail');
  await evalJs(cdp, `document.querySelector('[data-testid="job-open"]').click()`);
  await waitFor(cdp, `() => !!document.querySelector('[data-testid="job-detail-page"]')`, 'detail reopened');
  f = await evalJs(cdp, `window.__mq.facts()`);
  assert(f.state === 'completed' && f.doneSteps === 32 && f.eventCount >= 3, 'S2-reopened-detail', `state=${f.state} done=${f.doneSteps} events=${f.eventCount}`);
  await shot(cdp, 'qa-09-detail-reopened.png');

  // SC9: SSE Postgres listener count 0 -> 1 -> 0 (REQUIRED claim).
  log('SC9 invocation: SPA nav Home -> GET /__qa/listeners; SPA nav queue -> listeners; SPA nav Home -> listeners');
  await evalJs(cdp, `document.querySelector('a[href="/"]').click()`);
  await waitFor(cdp, `() => !!document.querySelector('[data-testid="needs-attention"]')`, 'home mounted');
  const l0 = await listenersUntil(0);
  assert(l0 === 0, 'S4-listeners-home-0', `listeners=${l0}`);
  await evalJs(cdp, `document.querySelector('[data-testid="recent-jobs-table"] [data-testid="job-open"]').click()`);
  await waitFor(cdp, `() => document.querySelector('[data-testid="job-stream-status"]')?.innerText === 'Live updates connected'`, 'detail stream live');
  const l1 = await listenersUntil(1);
  assert(l1 === 1, 'S4-listeners-mounted-1', `listeners=${l1}`);
  await evalJs(cdp, `document.querySelector('[data-testid="detail-queue-link"]').click()`);
  await waitFor(cdp, `() => !!document.querySelector('[data-testid="job-queue"]')`, 'queue mounted');
  const l1b = await listenersUntil(1);
  assert(l1b === 1, 'S4-listeners-queue-1', `listeners=${l1b}`);
  await evalJs(cdp, `document.querySelector('a[href="/"]').click()`);
  await waitFor(cdp, `() => !!document.querySelector('[data-testid="needs-attention"]')`, 'home mounted again');
  const l2 = await listenersUntil(0);
  assert(l2 === 0, 'S4-listeners-unmounted-0', `listeners=${l2}`);
  facts.listeners = { home: l0, mounted: l1, queue: l1b, afterUnmount: l2 };

  // SC10: failed job taxonomy message + allowed decision set (REQUIRED claim).
  log('SC10 invocation: GET __qa/failed-job?leagueId=... (real applyStepFailure, 401 signal); Page.navigate /jobs/:id');
  const failed = await qaGet(`/__qa/failed-job?leagueId=${leagueId}`);
  facts.failedJobId = failed.jobId;
  assert(failed.state === 'awaiting_decision' && failed.action === 'awaiting_decision', 'S6-failure-action', JSON.stringify(failed));
  await navigate(cdp, `${PANEL}/jobs/${failed.jobId}`);
  await waitFor(cdp, `() => !!document.querySelector('[data-testid="job-error"]')`, 'failure error notice');
  const errClass = await evalJs(cdp, `document.querySelector('[data-testid="job-error-class"]').innerText`);
  assert(errClass === 'fatal_config', 'S6-taxonomy-class', errClass);
  const errNotice = await evalJs(cdp, `document.querySelector('[data-testid="job-error"]').innerText`);
  assert(errNotice.includes('Fatal Discord configuration') && errNotice.includes('QA bot token refused') && errNotice.includes('Step 1'), 'S6-taxonomy-message', errNotice.replace(/\n/g, ' | '));
  f = await evalJs(cdp, `window.__mq.facts()`);
  const five = ['decision-retry', 'decision-skip-1', 'decision-adopt-1', 'decision-revert', 'decision-abort'];
  assert(JSON.stringify(f.decisions.map((d) => d.id)) === JSON.stringify(five) && f.decisions.every((d) => !d.disabled), 'S3-failure-five-decisions', JSON.stringify(f.decisions));
  const stepFailed = await evalJs(cdp, `document.querySelector('[data-testid="job-step"] .pill').textContent.trim()`);
  assert(stepFailed === 'failed', 'S6-step-failed', stepFailed);
  await shot(cdp, 'qa-10-failure-desktop.png');
  await setViewport(cdp, 390, 844, true);
  const mobileDecisions = await evalJs(cdp, `document.querySelectorAll('[data-testid^="decision-"]').length`);
  assert(mobileDecisions === 5, 'S6-failure-mobile-decisions', `count=${mobileDecisions}`);
  const mobileWidth2 = await evalJs(cdp, `document.documentElement.scrollWidth`);
  assert(mobileWidth2 === 390, 'S6-failure-mobile-width', `scrollWidth=${mobileWidth2}`);
  await shot(cdp, 'qa-11-failure-mobile.png');
  await setViewport(cdp, 1440, 1000, false);

  // SC13A: curl probes while the failed job still shows five decisions.
  log('SC13A invocation: curl -i probes (see qa-curl-*.txt for full transcripts)');
  const queueRaw = curl('queue-list', [`${API}/api/v1/leagues/${leagueId}/jobs`], authCookies);
  assert(statusOf(queueRaw) === 200, 'S1-api-queue-200');
  const detailRaw = curl('failed-detail-5decisions', [`${API}/api/v1/jobs/${failed.jobId}`], authCookies);
  assert(statusOf(detailRaw) === 200, 'S6-api-detail-200');
  const detailJson = JSON.parse(bodyOf(detailRaw));
  const apiDecisions = detailJson.allowedDecisions.map((d) => (d.stepSeq !== undefined ? `${d.type}-${d.stepSeq}` : d.type));
  assert(JSON.stringify(apiDecisions) === JSON.stringify(['retry', 'skip-1', 'adopt-1', 'revert', 'abort']), 'S3-api-allowed-decisions', JSON.stringify(apiDecisions));
  facts.apiAllowedDecisions = apiDecisions;
  const noauthRaw = curl('no-session', [`${API}/api/v1/jobs/${failed.jobId}`]);
  assert(statusOf(noauthRaw) === 401, 'A1-no-session-401');
  const terminalRaw = curl('decision-on-terminal', ['-X', 'POST', '-H', 'content-type: application/json', '-H', `x-csrf-token: ${authCookies.csrf}`, '-d', '{"type":"retry"}', `${API}/api/v1/jobs/${jobId}/decision`], authCookies);
  assert(statusOf(terminalRaw) === 409, 'A3-terminal-decision-409', statusOf(terminalRaw).toString());
  const terminalAfter = JSON.parse(bodyOf(curl('terminal-unchanged', [`${API}/api/v1/jobs/${jobId}`], authCookies)));
  assert(terminalAfter.job.state === 'completed' && terminalAfter.allowedDecisions.length === 0, 'A3-terminal-unchanged', terminalAfter.job.state);

  // SC11: home needs-attention block populated (REQUIRED CHECK item).
  log('SC11 invocation: SPA nav Home; assert needs-attention block contents');
  await evalJs(cdp, `document.querySelector('a[href="/"]').click()`);
  await waitFor(cdp, `() => !!document.querySelector('[data-testid="needs-attention"]')`, 'home mounted');
  await waitFor(cdp, `() => document.querySelectorAll('[data-testid="awaiting-job"]').length === 1 && document.querySelectorAll('[data-testid="open-alert"]').length === 1`, 'attention populated');
  const alertText = await evalJs(cdp, `document.querySelector('[data-testid="open-alert"]').innerText`);
  assert(alertText.includes('job.fatal_config') && alertText.includes('critical') && alertText.includes('Open job'), 'S7-open-alert', alertText.replace(/\n/g, ' | '));
  const recentRows = await evalJs(cdp, `document.querySelectorAll('[data-testid="recent-jobs-table"] tbody tr').length`);
  assert(recentRows === 2, 'S7-recent-jobs-2', `rows=${recentRows}`);
  const leagueCards = await evalJs(cdp, `document.querySelectorAll('[data-testid="dashboard-leagues"] .link-card').length`);
  assert(leagueCards === 1, 'S7-leagues-1', `cards=${leagueCards}`);
  await shot(cdp, 'qa-12-home-attention-desktop.png');
  await setViewport(cdp, 390, 844, true);
  const homeMobileWidth = await evalJs(cdp, `document.documentElement.scrollWidth`);
  assert(homeMobileWidth === 390, 'S7-home-mobile-width', `scrollWidth=${homeMobileWidth}`);
  await shot(cdp, 'qa-13-home-attention-mobile.png');
  await setViewport(cdp, 1440, 1000, false);

  // SC12: decision retry + active-state gating, same document.
  log('SC12 invocation: click awaiting job link (SPA); click [data-testid="decision-retry"]; observe state + decision set');
  await evalJs(cdp, `document.querySelector('[data-testid="awaiting-job"] a').click()`);
  await waitFor(cdp, `() => !!document.querySelector('[data-testid="job-detail-page"]')`, 'failed job detail');
  await evalJs(cdp, `window.__mq_marker2 = 'mq-dec-1'; 'set'`);
  await evalJs(cdp, `document.querySelector('[data-testid="decision-retry"]').click()`);
  await waitFor(cdp, `() => document.querySelector('[data-testid="job-state"]')?.dataset.state === 'running'`, 'retry moved job to running');
  await waitFor(cdp, `() => { const d = [...document.querySelectorAll('[data-testid^="decision-"]')].map((b) => b.getAttribute('data-testid')); return JSON.stringify(d) === JSON.stringify(['decision-revert','decision-abort']) && [...document.querySelectorAll('[data-testid^="decision-"]')].every((b) => !b.disabled); }`, 'settled decisions = revert + abort');
  const marker2 = await evalJs(cdp, `window.__mq_marker2`);
  assert(marker2 === 'mq-dec-1', 'S3-retry-no-refresh', `marker=${marker2}`);
  await shot(cdp, 'qa-14-after-retry.png');

  // SC13B: curl state-guard probes on the now-running job.
  log('SC13B invocation: curl -i double-abort state guard');
  const abort1 = curl('abort-first', ['-X', 'POST', '-H', 'content-type: application/json', '-H', `x-csrf-token: ${authCookies.csrf}`, '-d', '{"type":"abort"}', `${API}/api/v1/jobs/${failed.jobId}/decision`], authCookies);
  assert(statusOf(abort1) === 200, 'A3-abort-first-200');
  const abort2 = curl('abort-second', ['-X', 'POST', '-H', 'content-type: application/json', '-H', `x-csrf-token: ${authCookies.csrf}`, '-d', '{"type":"abort"}', `${API}/api/v1/jobs/${failed.jobId}/decision`], authCookies);
  assert(statusOf(abort2) === 409, 'A3-abort-second-409', statusOf(abort2).toString());

  // SC15: HTML-injection adversarial probe on the failure message surface.
  log('SC15 invocation: GET __qa/failed-job?message=<img src=x onerror="window.__xss=1">XSSQA; Page.navigate detail');
  const xss = await qaGet(`/__qa/failed-job?leagueId=${leagueId}&message=${encodeURIComponent('<img src=x onerror="window.__xss=1">XSSQA')}`);
  await navigate(cdp, `${PANEL}/jobs/${xss.jobId}`);
  await waitFor(cdp, `() => !!document.querySelector('[data-testid="job-error"]')`, 'xss job error notice');
  const xssCheck = await evalJs(cdp, `({ fired: window.__xss, img: !!document.querySelector('[data-testid="job-error"] img'), text: document.querySelector('[data-testid="job-error"]').innerText.includes('XSSQA') })`);
  assert(xssCheck.fired === undefined && !xssCheck.img && xssCheck.text, 'A7-message-injection-escaped', JSON.stringify(xssCheck));
  await shot(cdp, 'qa-17-xss-text.png');

  // SC14: revoked session -> /signin redirect + API 401 (REQUIRED claim).
  log('SC14 invocation: POST __qa/revoke-root-sessions; curl -i job API with old cookie; Page.navigate /jobs/:id');
  const revoked = await qaPost('/__qa/revoke-root-sessions', {});
  assert(revoked.revoked >= 1, 'S7-sessions-revoked', JSON.stringify(revoked));
  const revokedApi = curl('revoked-session-401', [`${API}/api/v1/jobs/${failed.jobId}`], authCookies);
  assert(statusOf(revokedApi) === 401, 'S7-revoked-api-401', statusOf(revokedApi).toString());
  await navigate(cdp, `${PANEL}/jobs/${failed.jobId}`);
  await waitFor(cdp, `() => location.pathname === '/signin' && document.body.innerText.includes('Sign in with Discord')`, 'redirected to /signin');
  const signInUrl = await evalJs(cdp, `location.href`);
  assert(signInUrl.endsWith('/signin'), 'S7-redirect-signin', signInUrl);
  await shot(cdp, 'qa-15-signin-redirect-desktop.png');
  const browser401 = await evalJs(cdp, `window.__mq.api('/api/v1/jobs/${failed.jobId}').then((r) => r.status)`);
  assert(browser401 === 401, 'S7-browser-api-401', `status=${browser401}`);
  await setViewport(cdp, 390, 844, true);
  await shot(cdp, 'qa-16-signin-redirect-mobile.png');
  await setViewport(cdp, 1440, 1000, false);

  facts.completed = true;
  writeFileSync(join(OUT, 'qa-manual-facts.json'), JSON.stringify(facts, null, 2));
  writeFileSync(join(OUT, 'qa-manual-actions.log'), logLines.join('\n') + '\n');
  log('=== driver complete ===');
  process.exit(process.exitCode ?? 0);
}

main().catch((error) => {
  log(`DRIVER ERROR :: ${error.stack ?? error}`);
  writeFileSync(join(OUT, 'qa-manual-actions.log'), logLines.join('\n') + '\n');
  process.exit(1);
});
