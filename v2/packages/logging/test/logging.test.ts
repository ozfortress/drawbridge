import { registerSecret, Secret, withSecretScope } from '@drawbridge/config';
import { describe, expect, it } from 'vitest';
import { createLogger, isSensitiveKey, redact } from '../src/index.js';

function capture() {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
  return {
    lines,
    logger,
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('redaction', () => {
  it('renders Secret values as markers, even at nested keys that are not sensitive', () => {
    const out = redact({ config: { bot: new Secret('super-secret-token') } }) as any;
    expect(JSON.stringify(out)).not.toContain('super-secret-token');
    expect(out.config.bot).toBe('[secret]');
  });

  it('redacts plain values under sensitive key names, in any casing or separator style', () => {
    const out = redact({
      API_KEY: 'abc',
      apiKey: 'def',
      authorization: 'Bearer ghi',
      'set-cookie': 'session=jkl',
      nested: { webhookUrl: 'https://hooks.example/mno' },
    }) as any;
    expect(out).toEqual({
      API_KEY: '[redacted]',
      apiKey: '[redacted]',
      authorization: '[redacted]',
      'set-cookie': '[redacted]',
      nested: { webhookUrl: '[redacted]' },
    });
  });

  it('keeps non-sensitive keys intact', () => {
    const out = redact({ guildId: '123', league: 'HL 27', count: 3 }) as any;
    expect(out).toEqual({ guildId: '123', league: 'HL 27', count: 3 });
  });

  it('handles Errors, Dates, bigints and circular references without throwing', () => {
    const cause = new Error('inner');
    const value: Record<string, unknown> = {
      when: new Date('2026-11-21T00:00:00.000Z'),
      big: 12345678901234567890n,
      error: new Error('outer', { cause }),
    };
    value['self'] = value;
    const out = redact(value) as any;
    expect(out.when).toBe('2026-11-21T00:00:00.000Z');
    expect(out.big).toBe('12345678901234567890');
    expect(out.error.message).toBe('outer');
    expect(out.error.cause.message).toBe('inner');
    expect(out.self).toBe('[circular]');
  });

  it('classifies sensitive key names', () => {
    expect(isSensitiveKey('DISCORD_BOT_TOKEN')).toBe(true);
    expect(isSensitiveKey('s3SecretAccessKey')).toBe(true);
    expect(isSensitiveKey('message')).toBe(false);
    expect(isSensitiveKey('retentionDays')).toBe(false);
  });
});

describe('logger', () => {
  it('emits one JSON object per line with time, level, message and bindings', () => {
    const { lines, logger, entries } = capture();
    logger.info('hello', { requestId: 'r1' });
    expect(lines).toHaveLength(1);
    const entry = entries()[0]!;
    expect(entry['level']).toBe('info');
    expect(entry['message']).toBe('hello');
    expect(entry['requestId']).toBe('r1');
    expect(typeof entry['time']).toBe('string');
  });

  it('filters below the configured level', () => {
    const debugLines: string[] = [];
    const infoLines: string[] = [];
    const debugLogger = createLogger({ level: 'debug', sink: (line) => debugLines.push(line) });
    const infoLogger = createLogger({ level: 'info', sink: (line) => infoLines.push(line) });

    debugLogger.debug('debug-visible');
    infoLogger.debug('debug-hidden');
    infoLogger.info('info-visible');

    expect(debugLines).toHaveLength(1);
    expect(debugLines[0]).toContain('debug-visible');
    expect(infoLines).toHaveLength(1);
    expect(infoLines[0]).toContain('info-visible');
  });

  it('never prints a secret, through direct fields, children or errors', () => {
    const { lines, logger } = capture();
    const child = logger.child({ requestId: 'r1', token: 'plain-token' });
    child.error('failed', {
      config: { botToken: new Secret('bot-secret-value'), password: 'db-password-value' },
      error: new Error('boom with bot-secret-value'),
    });
    const joined = lines.join('\n');
    expect(joined).not.toContain('bot-secret-value');
    expect(joined).not.toContain('plain-token');
    expect(joined).not.toContain('db-password-value');
  });

  it('scrubs a registered secret out of free text such as an error message', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
    registerSecret('registered-header-token');
    logger.error('upstream rejected', {
      error: new Error('AxiosError: header Authorization: Bearer registered-header-token'),
    });
    const joined = lines.join('\n');
    expect(joined).not.toContain('registered-header-token');
    expect(joined).toContain('[redacted]');
  });

  it('forgets secrets registered outside the current line', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
    withSecretScope(() => registerSecret('earlier-scope-secret'));
    logger.info('later', { note: 'mentions earlier-scope-secret in plain text' });
    expect(lines[0]).toContain('earlier-scope-secret');
  });

  it('child bindings do not leak into the parent logger', () => {
    const { logger, entries } = capture();
    const child = logger.child({ scope: 'child' });
    child.info('from child');
    logger.info('from parent');
    expect(entries()[0]!['scope']).toBe('child');
    expect(entries()[1]!['scope']).toBeUndefined();
  });
});
