import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  isSecret,
  parseConfig,
  redactedConfig,
  registerSecret,
  Secret,
  scrubText,
  withSecretScope,
} from '../src/index.js';

const validEnv = {
  NODE_ENV: 'production',
  RUN_MODE: 'all',
  DATABASE_URL: 'postgres://drawbridge:pw@db:5432/drawbridge',
  DRAWBRIDGE_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  DISCORD_APPLICATION_ID: '1573555530901880855',
  DISCORD_BOT_TOKEN: 'bot-token-value',
  DISCORD_CLIENT_SECRET: 'client-secret-value',
  ROOT_ADMIN_DISCORD_IDS: '111111111111111111, 222222222222222222',
  S3_ENDPOINT: 'http://minio:9000',
  S3_ACCESS_KEY_ID: 'minio',
  S3_SECRET_ACCESS_KEY: 'minio-secret-value',
  ALERT_WEBHOOK_URL: 'https://hooks.example/secret-path',
};

function config(overrides: Record<string, string | undefined> = {}) {
  return parseConfig({ ...validEnv, ...overrides });
}

describe('config', () => {
  it('parses a valid environment and applies defaults', () => {
    const cfg = config();
    expect(cfg.runMode).toBe('all');
    expect(cfg.webPort).toBe(8080);
    expect(cfg.webHost).toBe('0.0.0.0');
    expect(cfg.retentionDays).toBe(730);
    expect(cfg.citadelApiBaseUrl).toBe('http://127.0.0.1:3000/api/v1/');
    expect(cfg.rootAdminDiscordIds).toEqual(['111111111111111111', '222222222222222222']);
    expect(cfg.discordSharding).toBe('off');
  });

  it('wraps every secret so it never serialises to plain text', () => {
    const cfg = config();
    expect(isSecret(cfg.databaseUrl)).toBe(true);
    expect(isSecret(cfg.discordBotToken)).toBe(true);
    expect(isSecret(cfg.discordClientSecret)).toBe(true);
    expect(isSecret(cfg.s3SecretAccessKey)).toBe(true);
    expect(isSecret(cfg.masterKey)).toBe(true);

    expect(JSON.stringify(cfg)).not.toContain('bot-token-value');
    expect(JSON.stringify(cfg)).not.toContain('client-secret-value');
    expect(JSON.stringify(cfg)).not.toContain('minio-secret-value');
    expect(JSON.stringify(cfg)).not.toContain('pw@db');
    expect(JSON.stringify(redactedConfig(cfg))).not.toContain('bot-token-value');

    expect(cfg.discordBotToken.reveal()).toBe('bot-token-value');
    expect(String(cfg.discordBotToken)).toBe('[secret]');
  });

  it('rejects an unknown run mode', () => {
    expect(() => config({ RUN_MODE: 'streaming' })).toThrow(ConfigError);
    expect(() => config({ RUN_MODE: 'streaming' })).toThrow(/RUN_MODE/);
  });

  it('requires the database everywhere', () => {
    expect(() => config({ DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });

  it('requires Discord credentials outside the migrate role', () => {
    expect(() => config({ DISCORD_BOT_TOKEN: '' })).toThrow(/DISCORD_BOT_TOKEN/);
    expect(() => config({ DISCORD_APPLICATION_ID: '' })).toThrow(/DISCORD_APPLICATION_ID/);
  });

  it('requires the OAuth secret and a root admin for the web role', () => {
    expect(() => config({ DISCORD_CLIENT_SECRET: '' })).toThrow(/DISCORD_CLIENT_SECRET/);
    expect(() => config({ ROOT_ADMIN_DISCORD_IDS: '' })).toThrow(/ROOT_ADMIN_DISCORD_IDS/);
  });

  it('does not require the OAuth secret for the bot role', () => {
    const cfg = config({ RUN_MODE: 'bot', DISCORD_CLIENT_SECRET: '', ROOT_ADMIN_DISCORD_IDS: '' });
    expect(cfg.runMode).toBe('bot');
  });

  it('checks the master key length', () => {
    expect(() => config({ DRAWBRIDGE_MASTER_KEY: Buffer.alloc(16, 1).toString('base64') })).toThrow(
      /DRAWBRIDGE_MASTER_KEY/,
    );
  });

  it('reports several missing values at once, with field paths', () => {
    try {
      config({ DATABASE_URL: '', DISCORD_BOT_TOKEN: '' });
      throw new Error('expected a ConfigError');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('DISCORD_BOT_TOKEN');
    }
  });

  it('reports a malformed single value with its field path', () => {
    expect(() => config({ WEB_PORT: '99999' })).toThrow(/WEB_PORT/);
  });

  it('accepts placeholders in the test environment so CI can run without secrets', () => {
    const cfg = parseConfig({ NODE_ENV: 'test' });
    expect(cfg.runMode).toBe('all');
    expect(cfg.databaseUrl.reveal()).toBe('');
  });

  it('marks a Secret as [secret] under util.inspect too', () => {
    const value = new Secret('abc');
    expect(String(value)).toBe('[secret]');
    expect(JSON.stringify({ value })).toBe('{"value":"[secret]"}');
  });

  it('scopes registered secret values', () => {
    withSecretScope(() => {
      registerSecret('inside-scope-secret');
      expect(scrubText('text inside-scope-secret here')).toBe('text [redacted] here');
    });
    expect(scrubText('text inside-scope-secret here')).toBe('text inside-scope-secret here');
  });

  it('does not register short values, to avoid redacting unrelated text', () => {
    registerSecret('k1');
    expect(scrubText('key k1 is fine')).toBe('key k1 is fine');
  });
});
