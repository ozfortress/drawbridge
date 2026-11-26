import { describe, expect, it } from 'vitest';
import {
  type ApiErrorSignal,
  classifyError,
  DiscordOperationError,
  ERROR_CODE_CLASSES,
  isPermanentErrorClass,
  JOB_ERROR_CLASSES,
  signalData,
} from '../src/index.js';

describe('error taxonomy (02 §4.13)', () => {
  it('names exactly the seven classes and the code table from the plan', () => {
    expect(JOB_ERROR_CLASSES).toEqual([
      'rate_limited',
      'transient',
      'fatal_config',
      'missing_permission',
      'object_missing',
      'capacity',
      'invalid_input',
    ]);
    // Verified at build time: every §4.13 code maps to the plan's class.
    expect(ERROR_CODE_CLASSES).toEqual({
      50001: 'missing_permission',
      50013: 'missing_permission',
      10003: 'object_missing',
      10004: 'object_missing',
      10011: 'object_missing',
      30003: 'capacity',
      30005: 'capacity',
      30013: 'capacity',
      50035: 'invalid_input',
    });
  });

  it('classifies every §4.13 row', () => {
    const cases: Array<[ApiErrorSignal, string]> = [
      [{ status: 429, retryAfterSeconds: 2.5 }, 'rate_limited'],
      [{ status: 500 }, 'transient'],
      [{ status: 503, message: 'gateway unavailable' }, 'transient'],
      [{ network: true, message: 'socket hang up' }, 'transient'],
      [{ network: true }, 'transient'],
      [{ status: 401 }, 'fatal_config'],
      [{ status: 403 }, 'missing_permission'],
      [{ code: 50001 }, 'missing_permission'],
      [{ code: 50013 }, 'missing_permission'],
      [{ code: 10003 }, 'object_missing'],
      [{ code: 10004 }, 'object_missing'],
      [{ code: 10011 }, 'object_missing'],
      [{ code: 30005 }, 'capacity'],
      [{ code: 30013 }, 'capacity'],
      [{ code: 30003 }, 'capacity'],
      [{ code: 50035 }, 'invalid_input'],
      [{ status: 400, code: 50035 }, 'invalid_input'],
    ];
    for (const [signal, expected] of cases) {
      expect(classifyError(signal)).toBe(expected);
    }
  });

  it('lets a 429 outrank any code, and the code table outrank other statuses', () => {
    expect(classifyError({ status: 429, code: 50035 })).toBe('rate_limited');
    // Discord's own error code is more specific than its status line.
    expect(classifyError({ status: 403, code: 10003 })).toBe('object_missing');
    expect(classifyError({ status: 400, code: 30005 })).toBe('capacity');
  });

  it('falls back to invalid_input for signals the table does not name', () => {
    // An unmapped 4xx is permanent: silently retrying it is the one thing
    // the taxonomy exists to prevent.
    expect(classifyError({ status: 418 })).toBe('invalid_input');
    expect(classifyError({ status: 404 })).toBe('invalid_input');
    expect(classifyError({ message: 'something odd' })).toBe('invalid_input');
    expect(classifyError({})).toBe('invalid_input');
  });

  it('treats only rate_limited and transient as non-permanent', () => {
    for (const cls of JOB_ERROR_CLASSES) {
      expect(isPermanentErrorClass(cls)).toBe(cls !== 'rate_limited' && cls !== 'transient');
    }
  });

  it('carries the signal on DiscordOperationError', () => {
    const signal: ApiErrorSignal = { status: 429, retryAfterSeconds: 3, message: 'Too fast' };
    const err = new DiscordOperationError(signal);
    expect(err).toBeInstanceOf(DiscordOperationError);
    expect(err.name).toBe('DiscordOperationError');
    expect(err.signal).toBe(signal);
    expect(err.message).toBe('Too fast');
    expect(new DiscordOperationError({ status: 500 }).message).toBe('Discord operation failed');
  });

  it('serialises a signal to data without undefined holes', () => {
    expect(signalData({ status: 403, code: 50013, message: 'Missing Permissions' })).toEqual({
      status: 403,
      code: 50013,
      message: 'Missing Permissions',
    });
    expect(signalData({ network: true, retryAfterSeconds: 2.5 })).toEqual({
      network: true,
      retryAfterSeconds: 2.5,
    });
    expect(signalData({})).toEqual({});
  });
});
