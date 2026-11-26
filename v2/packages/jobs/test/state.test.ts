import { describe, expect, it } from 'vitest';
import {
  canTransition,
  enqueueEvent,
  InvalidTransition,
  isTerminalJobState,
  JOB_EVENT_TYPES,
  JOB_PAUSE_REASONS,
  JOB_STATES,
  JOB_STEP_STATUSES,
  type JobEvent,
  type JobEventDraft,
  type JobEventLevel,
  type JobEventType,
  type JobSnapshot,
  type JobState,
  TERMINAL_JOB_STATES,
  transition,
} from '../src/index.js';

/** A job in a state; paused jobs carry the reason they were paused with. */
const job = (state: JobState, pauseReason: string | null = null): JobSnapshot => ({
  state,
  pauseReason: pauseReason as JobSnapshot['pauseReason'],
});

/** A valid instance of every event type, for the exhaustive table test. */
function sampleEvent(type: JobEventType): JobEvent {
  switch (type) {
    case 'pause':
      return { type, reason: 'external' };
    case 'decide_skip':
      return { type, stepSeq: 4 };
    case 'complete_with_skips':
      return { type, skippedCount: 2 };
    default:
      return { type };
  }
}

/**
 * The expected edge set, hand-written from plan 02 §5.3-5.9. Everything not
 * listed here must be rejected, including every terminal state and every
 * `revert`/`finish_revert` from a state the guards do not allow.
 */
const EXPECTED: Record<JobState, Partial<Record<JobEventType, JobState>>> = {
  queued: { start: 'running', cancel: 'cancelled' },
  running: {
    pause: 'paused',
    need_decision: 'awaiting_decision',
    complete: 'completed',
    complete_with_skips: 'completed_with_skips',
    fail: 'failed',
    revert: 'reverting',
    cancel: 'cancelled',
  },
  paused: {
    resume: 'running',
    need_decision: 'awaiting_decision',
    revert: 'reverting',
    cancel: 'cancelled',
  },
  awaiting_decision: {
    decide_retry: 'running',
    decide_skip: 'running',
    decide_adopt: 'running',
    decide_revert: 'reverting',
    decide_abort: 'cancelled',
  },
  reverting: { finish_revert: 'reverted', need_decision: 'awaiting_decision' },
  completed: {},
  completed_with_skips: {},
  failed: {},
  cancelled: {},
  reverted: {},
};

describe('job vocabulary (02 §5.3-5.4)', () => {
  it('defines the states, pause reasons and step statuses exactly', () => {
    expect(JOB_STATES).toEqual([
      'queued',
      'running',
      'paused',
      'awaiting_decision',
      'completed',
      'completed_with_skips',
      'failed',
      'cancelled',
      'reverting',
      'reverted',
    ]);
    expect(JOB_PAUSE_REASONS).toEqual(['external', 'ratelimit', 'guild_unavailable']);
    expect(JOB_STEP_STATUSES).toEqual([
      'pending',
      'running',
      'done',
      'skipped',
      'failed',
      'compensated',
    ]);
    expect(JOB_STATES.filter(isTerminalJobState)).toEqual([...TERMINAL_JOB_STATES]);
  });
});

describe('transition table', () => {
  it('accepts every legal move and rejects every illegal one', () => {
    let legal = 0;
    let illegal = 0;
    for (const state of JOB_STATES) {
      for (const type of JOB_EVENT_TYPES) {
        const target = EXPECTED[state]?.[type];
        const snapshot = job(state, state === 'paused' ? 'external' : null);
        if (target === undefined) {
          illegal += 1;
          expect(canTransition(state, type)).toBe(false);
          expect(() => transition(snapshot, sampleEvent(type), {})).toThrow(InvalidTransition);
          continue;
        }
        legal += 1;
        expect(canTransition(state, type)).toBe(true);
        const result = transition(snapshot, sampleEvent(type), {});
        expect(result.state).toBe(target);
        expect(result.pauseReason).toBe(type === 'pause' ? 'external' : null);
        expect(result.finished).toBe(isTerminalJobState(target));
        expect(result.events).toHaveLength(1);
      }
    }
    expect(legal).toBe(20);
    expect(illegal).toBe(130);
  });

  it('never re-opens a finished job (completed -> running is illegal)', () => {
    for (const state of TERMINAL_JOB_STATES) {
      expect(JOB_EVENT_TYPES.filter((type) => canTransition(state, type))).toEqual([]);
      for (const type of ['start', 'resume', 'decide_retry'] as JobEventType[]) {
        expect(() => transition(job(state), sampleEvent(type), {})).toThrow(InvalidTransition);
      }
    }
    expect(() => transition(job('completed'), { type: 'complete' }, {})).toThrow(InvalidTransition);
  });

  it('enters reverting only from running, paused or awaiting_decision', () => {
    const sources = JOB_STATES.filter((state) =>
      JOB_EVENT_TYPES.some((type) => EXPECTED[state]?.[type] === 'reverting'),
    );
    expect(sources).toEqual(['running', 'paused', 'awaiting_decision']);

    const banned = ['queued', 'reverting', ...TERMINAL_JOB_STATES] as JobState[];
    for (const state of banned) {
      expect(canTransition(state, 'revert')).toBe(false);
      expect(canTransition(state, 'decide_revert')).toBe(false);
      expect(() => transition(job(state), { type: 'revert' }, {})).toThrow(InvalidTransition);
      expect(() => transition(job(state), { type: 'decide_revert' }, {})).toThrow(
        InvalidTransition,
      );
    }
    expect(transition(job('running'), { type: 'revert' }, {}).state).toBe('reverting');
    expect(transition(job('paused', 'external'), { type: 'revert' }, {}).state).toBe('reverting');
    expect(transition(job('awaiting_decision'), { type: 'decide_revert' }, {}).state).toBe(
      'reverting',
    );
  });

  it('reaches reverted only from reverting', () => {
    const sources = JOB_STATES.filter((state) =>
      JOB_EVENT_TYPES.some((type) => EXPECTED[state]?.[type] === 'reverted'),
    );
    expect(sources).toEqual(['reverting']);

    for (const state of JOB_STATES.filter((s) => s !== 'reverting')) {
      expect(() => transition(job(state), { type: 'finish_revert' }, {})).toThrow(
        InvalidTransition,
      );
    }
    const done = transition(job('reverting'), { type: 'finish_revert' }, {});
    expect(done.state).toBe('reverted');
    expect(done.finished).toBe(true);
  });

  it('queued -> running -> completed emits exactly three journal rows', () => {
    const rows: JobEventDraft[] = [enqueueEvent('tournament.setup', 'setup', 6)];

    let current: JobSnapshot = job('queued');
    const events: JobEvent[] = [{ type: 'start' }, { type: 'complete' }];
    for (const event of events) {
      const result = transition(current, event, {});
      current = { state: result.state, pauseReason: result.pauseReason };
      rows.push(...result.events);
    }

    expect(current).toEqual({ state: 'completed', pauseReason: null });
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.code)).toEqual(['job.queued', 'job.started', 'job.completed']);
    expect(rows.map((row) => row.level)).toEqual(['info', 'info', 'info']);
  });

  it('an illegal transition throws and emits nothing', () => {
    const rows: JobEventDraft[] = [];
    expect(() => {
      rows.push(...transition(job('completed'), { type: 'start' }, {}).events);
    }).toThrow(InvalidTransition);
    expect(rows).toEqual([]);

    let caught: InvalidTransition | undefined;
    try {
      transition(job('cancelled'), { type: 'pause', reason: 'external' }, {});
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransition);
      caught = error as InvalidTransition;
    }
    expect(caught?.from).toBe('cancelled');
    expect(caught?.event).toBe('pause');
  });

  it('rejects an unknown pause reason', () => {
    const bad = { type: 'pause', reason: 'coffee_break' } as unknown as JobEvent;
    expect(() => transition(job('running'), bad, {})).toThrow(InvalidTransition);
    expect(() => transition(job('running'), bad, {})).toThrow(/pause reason/);
  });

  it('fails closed on an unknown state or event at runtime', () => {
    expect(canTransition('hologram' as JobState, 'start')).toBe(false);
    expect(() => transition(job('hologram' as JobState), { type: 'start' }, {})).toThrow(
      InvalidTransition,
    );
    expect(() =>
      transition(job('running'), { type: 'teleport' } as unknown as JobEvent, {}),
    ).toThrow(InvalidTransition);
  });
});

describe('journal rows', () => {
  it('records the pause reason and clears it on resume', () => {
    const paused = transition(
      job('running'),
      { type: 'pause', reason: 'ratelimit' },
      {
        detail: 'global write rate halved',
      },
    );
    expect(paused).toMatchObject({
      state: 'paused',
      pauseReason: 'ratelimit',
      finished: false,
    });
    expect(paused.events[0]).toMatchObject({
      level: 'warn',
      code: 'job.paused',
      message: 'Job paused (ratelimit): global write rate halved',
    });
    expect(paused.events[0]?.data).toEqual({
      from: 'running',
      to: 'paused',
      reason: 'ratelimit',
    });

    const resumed = transition(job('paused', 'ratelimit'), { type: 'resume' }, {});
    expect(resumed.state).toBe('running');
    expect(resumed.pauseReason).toBe(null);
    expect(resumed.events[0]).toMatchObject({
      level: 'info',
      code: 'job.resumed',
      message: 'Job resumed',
    });
    expect(resumed.events[0]?.data).toEqual({
      from: 'paused',
      to: 'running',
      pauseReason: 'ratelimit',
    });
  });

  it('routes the five decisions out of awaiting_decision (02 §5.8)', () => {
    const cases: Array<{ event: JobEvent; to: JobState; code: string; level: JobEventLevel }> = [
      { event: { type: 'decide_retry' }, to: 'running', code: 'job.decision.retry', level: 'info' },
      { event: { type: 'decide_skip' }, to: 'running', code: 'job.decision.skip', level: 'warn' },
      { event: { type: 'decide_adopt' }, to: 'running', code: 'job.decision.adopt', level: 'info' },
      {
        event: { type: 'decide_revert' },
        to: 'reverting',
        code: 'job.decision.revert',
        level: 'warn',
      },
      {
        event: { type: 'decide_abort' },
        to: 'cancelled',
        code: 'job.decision.abort',
        level: 'warn',
      },
    ];
    for (const { event, to, code, level } of cases) {
      const result = transition(job('awaiting_decision'), event, {});
      expect(result.state).toBe(to);
      expect(result.finished).toBe(isTerminalJobState(to));
      expect(result.events[0]?.code).toBe(code);
      expect(result.events[0]?.level).toBe(level);
    }
    expect(() => transition(job('running'), { type: 'decide_retry' }, {})).toThrow(
      InvalidTransition,
    );

    const skip = transition(job('awaiting_decision'), { type: 'decide_skip', stepSeq: 7 }, {});
    expect(skip.events[0]?.data).toEqual({ from: 'awaiting_decision', to: 'running', stepSeq: 7 });
  });

  it('marks completion with skips and its level', () => {
    const withCount = transition(
      job('running'),
      { type: 'complete_with_skips', skippedCount: 2 },
      {
        detail: 'role assignment skipped',
      },
    );
    expect(withCount.state).toBe('completed_with_skips');
    expect(withCount.finished).toBe(true);
    expect(withCount.events[0]).toMatchObject({
      level: 'warn',
      code: 'job.completed_with_skips',
      message: 'Job completed with skips (2): role assignment skipped',
    });
    expect(withCount.events[0]?.data).toEqual({
      from: 'running',
      to: 'completed_with_skips',
      skippedCount: 2,
    });

    const withoutCount = transition(job('running'), { type: 'complete_with_skips' }, {});
    expect(withoutCount.events[0]?.message).toBe('Job completed with skips');
    expect(withoutCount.events[0]?.data).toEqual({ from: 'running', to: 'completed_with_skips' });
  });

  it('records failures as error-level rows', () => {
    const failed = transition(
      job('running'),
      { type: 'fail' },
      {
        detail: 'transient retries exhausted',
      },
    );
    expect(failed).toMatchObject({ state: 'failed', finished: true });
    expect(failed.events[0]).toMatchObject({
      level: 'error',
      code: 'job.failed',
      message: 'Job failed: transient retries exhausted',
    });
    expect(failed.events[0]?.data).toEqual({ from: 'running', to: 'failed' });
  });

  it('lets a stuck compensation ask for a decision, then resume the revert', () => {
    const asked = transition(
      job('reverting'),
      { type: 'need_decision' },
      {
        detail: '403 deleting role',
      },
    );
    expect(asked.state).toBe('awaiting_decision');
    expect(asked.events[0]).toMatchObject({
      level: 'warn',
      code: 'job.awaiting_decision',
      message: 'Job awaiting decision: 403 deleting role',
    });
    expect(asked.events[0]?.data).toEqual({ from: 'reverting', to: 'awaiting_decision' });

    const back = transition(job('awaiting_decision'), { type: 'decide_revert' }, {});
    expect(back.state).toBe('reverting');
    expect(back.events[0]).toMatchObject({ level: 'warn', code: 'job.decision.revert' });

    const done = transition(job('reverting'), { type: 'finish_revert' }, {});
    expect(done.state).toBe('reverted');
    expect(done.events[0]).toMatchObject({ level: 'info', code: 'job.reverted' });
  });

  it('emits the enqueue row createJob writes, byte for byte', () => {
    expect(enqueueEvent('tournament.setup', 'setup', 3)).toEqual({
      level: 'info',
      code: 'job.queued',
      message: 'Job queued (3 steps)',
      data: { type: 'tournament.setup', lane: 'setup' },
    });
  });
});
