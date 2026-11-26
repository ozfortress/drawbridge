import { JOB_LANES } from '@drawbridge/jobs';
import { describe, expect, it } from 'vitest';
import type { DiscordOp } from '../src/index.js';
import {
  createDiscordExecutor,
  DEFAULT_EXECUTOR_LIMITS,
  type DiscordExecutorAlert,
  type DiscordWriteRequest,
  type RateLimitHit,
  type StepDuration,
} from '../src/index.js';
import { FakeDiscord, FakeScheduler } from './executor-helpers.js';

const GUILD_A = '111111111111111111';
const GUILD_B = '222222222222222222';
const GUILD_C = '333333333333333333';

/** One write request, with the lane and tag baked in. */
function write(op: DiscordOp, lane: DiscordWriteRequest['lane'], seq: number): DiscordWriteRequest {
  return { op, lane, jobId: '0192c0de-0000-7000-8000-000000000020', seq };
}

/** A rolling-window check: the most dispatches inside any `span` window. */
function maxInWindow(times: readonly number[], span: number): number {
  let max = 0;
  for (let i = 0; i < times.length; i += 1) {
    const from = times[i] ?? 0;
    const count = times.filter((t) => t > from - span && t <= from).length;
    max = Math.max(max, count);
  }
  return max;
}

/** Records every hook call, for asserting what fired. */
function recorder() {
  const rateHits: RateLimitHit[] = [];
  const durations: StepDuration[] = [];
  const alerts: DiscordExecutorAlert[] = [];
  return {
    rateHits,
    durations,
    alerts,
    metrics: {
      onRateLimit(hit: RateLimitHit): void {
        rateHits.push(hit);
      },
      onStepDuration(duration: StepDuration): void {
        durations.push(duration);
      },
    },
    alert: (alert: DiscordExecutorAlert): void => {
      alerts.push(alert);
    },
  };
}

describe('the Discord write executor (todo 20)', () => {
  it('names the five lanes in 02 §4.4 order and the provisional budgets', () => {
    expect(JOB_LANES).toEqual(['interactive', 'matches', 'setup', 'repair', 'maintenance']);
    expect(DEFAULT_EXECUTOR_LIMITS).toEqual({
      perGuildConcurrency: 2,
      globalWritesPerSecond: 10,
      rateHalvingMs: 60_000,
      invalidRequestAlertThreshold: 1_000,
      invalidRequestWindowMs: 600_000,
    });
  });

  it('dispatches queued writes in lane order, not arrival order', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({ scheduler, hold: true });
    const rec = recorder();
    const executor = createDiscordExecutor({
      port,
      clock: scheduler.clock,
      sleep: scheduler.sleep,
      metrics: rec.metrics,
    });

    // The first submit dispatches at once; the rest queue behind the rate
    // gate while one guild slot stays busy, so the queue is what orders them.
    const maintenance = write(
      { kind: 'send_message', guildId: GUILD_A, channelId: '444444444444444444' },
      'maintenance',
      1,
    );
    const first = executor.executeWrite(maintenance);
    const rest = [
      write(
        { kind: 'send_message', guildId: GUILD_A, channelId: '444444444444444444' },
        'repair',
        2,
      ),
      write(
        { kind: 'send_message', guildId: GUILD_A, channelId: '444444444444444444' },
        'setup',
        3,
      ),
      write(
        { kind: 'send_message', guildId: GUILD_A, channelId: '444444444444444444' },
        'matches',
        4,
      ),
      write(
        { kind: 'send_message', guildId: GUILD_A, channelId: '444444444444444444' },
        'interactive',
        5,
      ),
    ].map((request) => executor.executeWrite(request));

    await scheduler.advance(100); // the second slot takes the interactive lane
    port.release(0);
    await scheduler.advance(100);
    port.release(1);
    await scheduler.advance(100);
    port.release(2);
    await scheduler.advance(100);
    port.release(3);
    port.release(4);
    const settled = await Promise.all([first, ...rest]);

    expect(settled.every((result) => result.status === 'done')).toBe(true);
    expect(port.records.map((record) => ({ at: record.at, method: record.method }))).toEqual([
      { at: 0, method: 'sendMessage' },
      { at: 100, method: 'sendMessage' },
      { at: 200, method: 'sendMessage' },
      { at: 300, method: 'sendMessage' },
      { at: 400, method: 'sendMessage' },
    ]);
    // The four queued writes ran interactive, matches, setup, repair — the
    // exact 02 §4.4 order — although they were submitted in reverse.
    expect(rec.durations.map((duration) => duration.lane)).toEqual([
      'maintenance',
      'interactive',
      'matches',
      'setup',
      'repair',
    ]);
  });

  it('holds 10 writes across 3 guilds to 2 per guild and 10 per second', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({ scheduler, durationMs: 250 });
    const executor = createDiscordExecutor({
      port,
      clock: scheduler.clock,
      sleep: scheduler.sleep,
    });

    // Grouped by guild so each guild's second write lands while its first is
    // still in flight: every guild must be seen at its concurrency cap.
    const ops: DiscordOp[] = [
      { kind: 'send_message', guildId: GUILD_A, channelId: '444444444444444444' },
      { kind: 'send_message', guildId: GUILD_A, channelId: '444444444444444444' },
      { kind: 'send_message', guildId: GUILD_B, channelId: '444444444444444444' },
      { kind: 'send_message', guildId: GUILD_B, channelId: '444444444444444444' },
      { kind: 'send_message', guildId: GUILD_B, channelId: '444444444444444444' },
      { kind: 'send_message', guildId: GUILD_C, channelId: '444444444444444444' },
      { kind: 'send_message', guildId: GUILD_C, channelId: '444444444444444444' },
      { kind: 'send_message', guildId: GUILD_C, channelId: '444444444444444444' },
      { kind: 'send_message', guildId: GUILD_A, channelId: '444444444444444444' },
      { kind: 'send_message', guildId: GUILD_A, channelId: '444444444444444444' },
    ];
    const results = ops.map((op, index) => executor.executeWrite(write(op, 'setup', index + 1)));
    await scheduler.advance(1_200);
    const settled = await Promise.all(results);

    expect(settled.every((result) => result.status === 'done')).toBe(true);
    // The global rate: 10 dispatches, one per 100 ms, never two closer, and
    // no second-window holding more than the budget allows.
    expect(port.records.map((record) => record.at)).toEqual([
      0, 100, 200, 300, 400, 500, 600, 700, 800, 900,
    ]);
    expect(
      maxInWindow(
        port.records.map((record) => record.at),
        1_000,
      ),
    ).toBe(10);
    // The per-guild cap: every guild peaks at exactly 2 in flight, none higher.
    expect(port.peakInFlight(GUILD_A)).toBe(2);
    expect(port.peakInFlight(GUILD_B)).toBe(2);
    expect(port.peakInFlight(GUILD_C)).toBe(2);
  });

  it('halves the global rate for exactly 60s after a 429, then restores', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({
      scheduler,
      script: [
        undefined,
        { status: 429, retryAfterSeconds: 2.5, bucket: 'hash-1', message: 'Too fast' },
      ],
    });
    const executor = createDiscordExecutor({
      port,
      clock: scheduler.clock,
      sleep: scheduler.sleep,
    });

    const batch = (count: number, seqFrom: number): Promise<unknown>[] =>
      Array.from({ length: count }, (_, index) =>
        executor.executeWrite(
          write(
            { kind: 'send_message', guildId: GUILD_A, channelId: '444444444444444444' },
            'setup',
            seqFrom + index,
          ),
        ),
      );
    const first = batch(12, 1);
    await scheduler.advance(2_200);
    // The 429 landed at t=100; from there the rate is 5/s until t=60100.
    expect(port.records.slice(0, 12).map((record) => record.at)).toEqual([
      0, 100, 300, 500, 700, 1_000, 1_200, 1_400, 1_600, 1_800, 2_000, 2_200,
    ]);

    const second = batch(2, 13);
    await scheduler.advance(500);
    expect(port.records.slice(12, 14).map((record) => record.at)).toEqual([2_400, 2_600]);
    await Promise.all([...first, ...second]);

    // Exactly 60s after the 429: the rate restores at once, and the next
    // writes pace at 100 ms, not the halved 200 ms.
    await scheduler.advance(57_400);
    expect(scheduler.clock()).toBe(60_100);
    const third = batch(3, 15);
    await scheduler.advance(300);
    expect(port.records.slice(14).map((record) => record.at)).toEqual([60_100, 60_200, 60_300]);
    await Promise.all(third);

    // The halved phase never let more than 5 dispatches inside a second.
    const halved = port.records.map((record) => record.at).filter((at) => at > 100 && at < 60_100);
    expect(maxInWindow(halved, 1_000)).toBeLessThanOrEqual(5);
  });

  it('honors retry_after without consuming a step attempt, and records the 429 by bucket', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({
      scheduler,
      script: [
        {
          status: 429,
          retryAfterSeconds: 2.5,
          bucket: 'hash-1',
          rateLimitScope: 'user',
          message: 'Too fast',
        },
      ],
    });
    const rec = recorder();
    const executor = createDiscordExecutor({
      port,
      clock: scheduler.clock,
      sleep: scheduler.sleep,
      metrics: rec.metrics,
      alert: rec.alert,
    });

    const result = await executor.executeWrite(
      write({ kind: 'create_role', guildId: GUILD_A, name: 'Division X' }, 'setup', 1),
    );
    expect(result).toEqual({
      status: 'failed',
      failure: {
        class: 'rate_limited',
        action: 'pause_ratelimit',
        retryAfterSeconds: 2.5,
        signal: expect.anything(),
      },
    });

    // The 429 hook carries the bucket and the retry_after the engine pauses on.
    expect(rec.rateHits).toEqual([
      {
        bucket: 'hash-1',
        scope: 'user',
        retryAfterSeconds: 2.5,
        lane: 'setup',
        guildId: GUILD_A,
      },
    ]);
    expect(executor.rateLimitHits().get('hash-1')).toBe(1);

    // A user-scoped 429 counts toward the invalid budget (02 §4.5).
    expect(executor.invalidRequestCount()).toBe(1);
    // Nothing stopped: the executor keeps accepting writes.
    expect(executor.isStopped()).toBe(false);
  });

  it('counts 429s per bucket and leaves shared-scope ones outside the invalid budget', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({
      scheduler,
      script: [
        { status: 429, retryAfterSeconds: 1, bucket: 'bucket-a' },
        { status: 429, retryAfterSeconds: 1, bucket: 'bucket-b' },
        { status: 429, retryAfterSeconds: 1, bucket: 'bucket-a' },
        { status: 429, retryAfterSeconds: 1, bucket: 'bucket-a', rateLimitScope: 'shared' },
        { status: 429, retryAfterSeconds: 1 },
      ],
    });
    const executor = createDiscordExecutor({
      port,
      clock: scheduler.clock,
      sleep: scheduler.sleep,
    });

    const results = [1, 2, 3, 4, 5].map((seq) =>
      executor.executeWrite(
        write(
          { kind: 'delete_role', guildId: GUILD_A, roleId: '222222222222222222' },
          'repair',
          seq,
        ),
      ),
    );
    await scheduler.advance(2_000);
    await Promise.all(results);

    expect(Object.fromEntries(executor.rateLimitHits())).toEqual({
      'bucket-a': 3,
      'bucket-b': 1,
      unknown: 1,
    });
    // bucket-a(3): two unscoped plus one shared; the shared-scope one is the
    // per-IP bucket (02 §4.5) and must not count; unscoped counts.
    expect(executor.invalidRequestCount()).toBe(4);
  });

  it('stops all writes on a 401: one alert, queued refused, later writes never reach the port', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({
      scheduler,
      hold: true,
      script: [{ status: 401, message: '401: Unauthorized' }],
    });
    const rec = recorder();
    const executor = createDiscordExecutor({
      port,
      clock: scheduler.clock,
      sleep: scheduler.sleep,
      metrics: rec.metrics,
      alert: rec.alert,
    });

    const requests = [1, 2, 3].map((seq) =>
      executor.executeWrite(
        write({ kind: 'create_text_channel', guildId: GUILD_A, name: 'general' }, 'setup', seq),
      ),
    );
    await scheduler.advance(100); // the second guild slot takes the second write

    // The first write comes back 401: the stop fires, the queued third write
    // is refused, and exactly one alert is raised.
    port.release(0);
    await scheduler.settle();
    expect(executor.isStopped()).toBe(true);
    expect(port.records.length).toBe(2); // the in-flight second write stands

    // A write submitted after the stop is refused without a port call.
    const after = await executor.executeWrite(
      write({ kind: 'create_role', guildId: GUILD_A, name: 'Division X' }, 'setup', 4),
    );
    expect(port.records.length).toBe(2);
    expect(after).toMatchObject({
      status: 'failed',
      failure: { class: 'fatal_config', action: 'awaiting_decision' },
    });

    port.release(1); // the in-flight write finishes; its result stands
    const settled = await Promise.all(requests);
    expect(settled[0]).toMatchObject({
      status: 'failed',
      failure: { class: 'fatal_config', action: 'awaiting_decision' },
    });
    expect(settled[1]?.status).toBe('done');
    expect(settled[2]).toMatchObject({
      status: 'failed',
      failure: { class: 'fatal_config', action: 'awaiting_decision' },
    });

    // One alert for the stop, raised once — and the 401 counted as invalid.
    expect(rec.alerts).toEqual([
      {
        kind: 'discord.fatal_config',
        guildId: GUILD_A,
        jobId: '0192c0de-0000-7000-8000-000000000020',
        message:
          'Discord rejected the bot token with 401; all writes stop until the token is fixed',
      },
    ]);
    expect(executor.invalidRequestCount()).toBe(1);
    // The refused writes report their duration like any other.
    expect(rec.durations.map((duration) => duration.outcome).sort()).toEqual([
      'done',
      'failed',
      'refused',
      'refused',
    ]);
  });

  it('alerts once at 1000 invalid requests in 10 minutes, and again only after the window drains', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({ scheduler, failAll: { status: 403, code: 50013 } });
    const rec = recorder();
    const executor = createDiscordExecutor({
      port,
      clock: scheduler.clock,
      sleep: scheduler.sleep,
      limits: { globalWritesPerSecond: 1_000 },
      alert: rec.alert,
    });

    const send = (count: number, seqFrom: number): Promise<unknown>[] =>
      Array.from({ length: count }, (_, index) =>
        executor.executeWrite(
          write(
            { kind: 'send_message', guildId: GUILD_A, channelId: '444444444444444444' },
            'setup',
            seqFrom + index,
          ),
        ),
      );

    // 999 invalid responses: no alert yet.
    const first = send(999, 1);
    await scheduler.advance(2_000);
    await Promise.all(first);
    expect(executor.invalidRequestCount()).toBe(999);
    expect(rec.alerts).toEqual([]);

    // The 1000th crosses the threshold; the 1001st adds no second alert.
    const second = send(2, 1_000);
    await scheduler.advance(100);
    await Promise.all(second);
    expect(executor.invalidRequestCount()).toBe(1_001);
    expect(rec.alerts).toEqual([
      {
        kind: 'discord.invalid_request_budget',
        count: 1_000,
        message: '1000 invalid Discord requests inside 10 minutes; Discord bans at 10,000',
      },
    ]);

    // The window slides past all of it: a fresh run can alert again.
    await scheduler.advance(600_100);
    const third = send(1_000, 2_000);
    await scheduler.advance(2_000);
    await Promise.all(third);
    expect(executor.invalidRequestCount()).toBe(1_000);
    expect(
      rec.alerts.filter((alert) => alert.kind === 'discord.invalid_request_budget'),
    ).toHaveLength(2);
  });

  it('fires the step-duration hook for every settled write', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({ scheduler, durationMs: 250 });
    const rec = recorder();
    const executor = createDiscordExecutor({
      port,
      clock: scheduler.clock,
      sleep: scheduler.sleep,
      metrics: rec.metrics,
    });

    const results = [
      executor.executeWrite(
        write({ kind: 'create_role', guildId: GUILD_A, name: 'Division X' }, 'matches', 1),
      ),
      executor.executeWrite(
        write(
          {
            kind: 'pin_message',
            guildId: GUILD_B,
            channelId: '444444444444444444',
            messageId: '666666666666666666',
          },
          'interactive',
          2,
        ),
      ),
    ];
    await scheduler.advance(500);
    await Promise.all(results);

    expect(rec.durations).toEqual([
      { lane: 'matches', kind: 'create_role', guildId: GUILD_A, durationMs: 250, outcome: 'done' },
      {
        lane: 'interactive',
        kind: 'pin_message',
        guildId: GUILD_B,
        durationMs: 350,
        outcome: 'done',
      },
    ]);
  });

  it('maps a 5xx answer to a transient retry, not a permanent park', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({
      scheduler,
      failAll: { status: 503, message: 'gateway unavailable' },
    });
    const executor = createDiscordExecutor({
      port,
      clock: scheduler.clock,
      sleep: scheduler.sleep,
    });

    const result = await executor.executeWrite(
      write({ kind: 'create_role', guildId: GUILD_A, name: 'Division X' }, 'setup', 1),
    );
    expect(result).toMatchObject({
      status: 'failed',
      failure: { class: 'transient', action: 'retry', signal: { status: 503 } },
    });
    // A 5xx is Discord serving the request: not an invalid one.
    expect(executor.invalidRequestCount()).toBe(0);
  });

  it('survives throwing hooks: the write still settles and the next one runs', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({
      scheduler,
      script: [undefined, { status: 429, retryAfterSeconds: 1, bucket: 'b' }],
    });
    const executor = createDiscordExecutor({
      port,
      clock: scheduler.clock,
      sleep: scheduler.sleep,
      metrics: {
        onRateLimit(): void {
          throw new Error('metrics sink down');
        },
        onStepDuration(): void {
          throw new Error('metrics sink down');
        },
      },
    });

    const first = await executor.executeWrite(
      write(
        { kind: 'send_message', guildId: GUILD_A, channelId: '444444444444444444' },
        'setup',
        1,
      ),
    );
    expect(first).toMatchObject({ status: 'done' });

    await scheduler.advance(150);
    const rateLimited = await executor.executeWrite(
      write(
        { kind: 'send_message', guildId: GUILD_A, channelId: '444444444444444444' },
        'setup',
        2,
      ),
    );
    expect(rateLimited).toMatchObject({ failure: { class: 'rate_limited' } });

    // Both hooks threw; the executor kept working. The halved rate after
    // the 429 spaces this write out, so drive the timeline past its gate.
    await scheduler.advance(150);
    const after = executor.executeWrite(
      write(
        { kind: 'send_message', guildId: GUILD_A, channelId: '444444444444444444' },
        'setup',
        3,
      ),
    );
    await scheduler.advance(500);
    expect((await after).status).toBe('done');
    expect(executor.rateLimitHits().get('b')).toBe(1);
  });

  it('stops on a 401 even with no alert hook wired, or a failing one', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({ scheduler, failAll: { status: 401 } });
    const warnings: string[] = [];
    const logger = {
      warn(message: string): void {
        warnings.push(message);
      },
      error(): void {},
    };
    const executor = createDiscordExecutor({
      port,
      clock: scheduler.clock,
      sleep: scheduler.sleep,
      logger,
      alert: (): void => {
        throw new Error('alert sink down');
      },
    });

    const result = await executor.executeWrite(
      write({ kind: 'create_role', guildId: GUILD_A, name: 'Division X' }, 'setup', 1),
    );
    expect(result).toMatchObject({ failure: { class: 'fatal_config' } });
    expect(executor.isStopped()).toBe(true);
    expect(warnings).toContain('executor alert hook failed');

    // And with no hook at all, the stop is the same.
    const bare = createDiscordExecutor({
      port,
      clock: scheduler.clock,
      sleep: scheduler.sleep,
    });
    const bareResult = await bare.executeWrite(
      write({ kind: 'create_role', guildId: GUILD_A, name: 'Division X' }, 'setup', 1),
    );
    expect(bareResult).toMatchObject({ failure: { class: 'fatal_config' } });
    expect(bare.isStopped()).toBe(true);
  });

  it('never hangs a write when the injected wait itself fails', async () => {
    const scheduler = new FakeScheduler();
    const port = new FakeDiscord({ scheduler });
    const executor = createDiscordExecutor({
      port,
      clock: scheduler.clock,
      sleep: (): Promise<void> => Promise.reject(new Error('scheduler broke')),
    });

    // The first dispatch needs no wait; the second hits the broken one.
    const first = executor.executeWrite(
      write(
        { kind: 'send_message', guildId: GUILD_A, channelId: '444444444444444444' },
        'setup',
        1,
      ),
    );
    const second = executor.executeWrite(
      write(
        { kind: 'send_message', guildId: GUILD_A, channelId: '444444444444444444' },
        'setup',
        2,
      ),
    );
    const settled = await Promise.all([first, second]);

    expect(settled[0]?.status).toBe('done');
    expect(settled[1]).toMatchObject({
      status: 'failed',
      failure: { class: 'invalid_input', action: 'awaiting_decision' },
    });
    expect(port.records).toHaveLength(1);
  });
});
