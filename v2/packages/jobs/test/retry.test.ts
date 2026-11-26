import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_PAUSE_ESCALATION_MS,
  EXTERNAL_PROBE_INTERVAL_MS,
  evaluateExternalPause,
  isTransientExhausted,
  nextProbeAt,
  nextRetryAt,
  type Random01,
  rateLimitRetryAt,
  TRANSIENT_BASE_MS,
  TRANSIENT_CAP_MS,
  TRANSIENT_JITTER_FRACTION,
  TRANSIENT_MAX_ATTEMPTS,
  transientBackoffMs,
} from '../src/index.js';

const CLOCK_MS = 1_700_000_000_000;
const clock = () => CLOCK_MS;

/** A fixed random draw; 0.5 lands exactly on the unjittered delay. */
const mid: Random01 = () => 0.5;

describe('transient backoff (02 §5.7)', () => {
  it('doubles from 2 seconds, jitters ±20 %, caps at 5 minutes', () => {
    const unjittered = [1, 2, 3, 4, 5].map((attempt) => transientBackoffMs(attempt, mid));
    expect(unjittered).toEqual([2_000, 4_000, 8_000, 16_000, 32_000]);
    expect(TRANSIENT_BASE_MS).toBe(2_000);
    expect(TRANSIENT_JITTER_FRACTION).toBe(0.2);
    expect(TRANSIENT_CAP_MS).toBe(5 * 60_000);

    // The ±20 % jitter window, at the draw extremes.
    expect(transientBackoffMs(1, () => 0)).toBe(1_600);
    expect(transientBackoffMs(1, () => 0.999)).toBe(2_399.2);
    // A mid draw stays inside the window for every scheduled attempt.
    for (let attempt = 1; attempt <= 5; attempt++) {
      const raw = 2_000 * 2 ** (attempt - 1);
      expect(transientBackoffMs(attempt, () => 0.1)).toBeGreaterThanOrEqual(0.8 * raw);
      expect(transientBackoffMs(attempt, () => 0.1)).toBeLessThanOrEqual(1.2 * raw);
    }

    // The cap binds after jitter, well before the 6 attempts are spent.
    expect(transientBackoffMs(8, () => 1)).toBe(TRANSIENT_CAP_MS);
    expect(transientBackoffMs(8, mid)).toBe(256_000);
    expect(transientBackoffMs(10, () => 1)).toBe(TRANSIENT_CAP_MS);
  });

  it('schedules the next retry on the injected clock', () => {
    expect(nextRetryAt(1, clock, mid)?.getTime()).toBe(CLOCK_MS + 2_000);
    expect(nextRetryAt(3, clock, () => 0)?.getTime()).toBe(CLOCK_MS + 6_400);
  });

  it('spends the budget at six attempts', () => {
    expect(TRANSIENT_MAX_ATTEMPTS).toBe(6);
    expect(isTransientExhausted(0)).toBe(false);
    expect(isTransientExhausted(5)).toBe(false);
    expect(isTransientExhausted(6)).toBe(true);
    expect(isTransientExhausted(7)).toBe(true);
  });
});

describe('rate-limit wake-up (02 §5.7)', () => {
  it('waits exactly retry_after on the injected clock', () => {
    expect(rateLimitRetryAt(12.5, clock)?.getTime()).toBe(CLOCK_MS + 12_500);
    expect(rateLimitRetryAt(0, clock)?.getTime()).toBe(CLOCK_MS);
  });
});

describe('external pause probes (02 §5.7)', () => {
  it('probes every 30 seconds', () => {
    expect(EXTERNAL_PROBE_INTERVAL_MS).toBe(30_000);
    expect(nextProbeAt(clock)?.getTime()).toBe(CLOCK_MS + 30_000);
  });

  it('escalates after 24 hours', () => {
    expect(EXTERNAL_PAUSE_ESCALATION_MS).toBe(24 * 60 * 60_000);
  });

  it('resumes on a successful probe, however long the pause lasted', () => {
    expect(evaluateExternalPause({ now: 0, pausedSince: 0, probeSucceeded: true })).toEqual({
      action: 'resume',
    });
    expect(
      evaluateExternalPause({
        now: 25 * 60 * 60_000,
        pausedSince: 0,
        probeSucceeded: true,
      }),
    ).toEqual({ action: 'resume' });
  });

  it('postpones a failing probe until the pause is 24 hours old', () => {
    const day = EXTERNAL_PAUSE_ESCALATION_MS;
    expect(evaluateExternalPause({ now: 100_000, pausedSince: 0, probeSucceeded: false })).toEqual({
      action: 'postpone',
    });
    expect(evaluateExternalPause({ now: day - 1, pausedSince: 0, probeSucceeded: false })).toEqual({
      action: 'postpone',
    });
    expect(evaluateExternalPause({ now: day, pausedSince: 0, probeSucceeded: false })).toEqual({
      action: 'escalate',
    });
    expect(evaluateExternalPause({ now: day + 5, pausedSince: 0, probeSucceeded: false })).toEqual({
      action: 'escalate',
    });
  });
});
