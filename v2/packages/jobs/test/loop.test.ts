/**
 * Unit tests for the worker loop's pure pieces: the signal-aware idle
 * wait. Timers are faked, so nothing here sleeps.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signalAwareSleep } from '../src/index.js';

describe('signal-aware sleep', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves when the timer fires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let done = false;
    const sleeping = signalAwareSleep(5_000, new AbortController().signal).then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sleeping;
    expect(done).toBe(true);
  });

  it('resolves at once when the signal aborts mid-wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    let done = false;
    const sleeping = signalAwareSleep(60_000, controller.signal).then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(false);
    controller.abort();
    await sleeping;
    expect(done).toBe(true);
  });

  it('resolves immediately for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await signalAwareSleep(60_000, controller.signal);
  });
});
