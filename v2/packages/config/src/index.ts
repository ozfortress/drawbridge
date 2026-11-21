/**
 * Bootstrap configuration.
 *
 * Only values needed before the database is reachable live here. Everything
 * else (leagues, channels, templates, FAQ text, Citadel keys) is stored in the
 * database and edited in the panel.
 *
 * Secrets are wrapped in `Secret` so that accidental serialisation (logs,
 * error reports, JSON) cannot reveal them.
 */
import { z } from 'zod';

export const RUN_MODES = ['all', 'web', 'bot', 'worker', 'migrate'] as const;
export type RunMode = (typeof RUN_MODES)[number];

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Marker for a value that must never be printed or serialised. */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
    // Remember it for the current logging scope so free text (error messages,
    // stack traces) containing it can be scrubbed too. Short values are not
    // registered: scrubbing them could redact unrelated text.
    if (value.length >= 8) secretRegistry.add(value);
  }

  /** The only supported way to read the real value. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return '[secret]';
  }

  toJSON(): string {
    return '[secret]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[secret]';
  }
}

export function isSecret(value: unknown): value is Secret {
  return value instanceof Secret;
}

/**
 * Process-local registry of secret values seen in the current scope.
 *
 * Code that publishes secrets (for example a request carrying an
 * `Authorization` header) registers them, so structured logs can remove the
 * value wherever it appears, including inside error text.
 */
const secretRegistry = new Set<string>();

export function registerSecret(value: string): void {
  if (typeof value === 'string' && value.length >= 8) secretRegistry.add(value);
}

/** Values that are definitely secret. Internal to log scrubbing. */
export function currentSecretValues(): ReadonlySet<string> {
  return secretRegistry;
}

/**
 * Removes every value registered in the scope from a string.
 * Returns the scrubbed string.
 */
export function scrubText(text: string): string {
  let out = text;
  for (const value of secretRegistry) {
    if (value.length >= 8 && out.includes(value)) {
      out = out.split(value).join('[redacted]');
    }
  }
  return out;
}

/** Runs `fn` with a fresh scope, then forgets every value registered in it. */
export function withSecretScope<T>(fn: () => T): T {
  const before = new Set(secretRegistry);
  try {
    return fn();
  } finally {
    for (const value of secretRegistry) {
      if (!before.has(value)) secretRegistry.delete(value);
    }
  }
}

const toSecret = (value: string) => new Secret(value);

const requiredSecret = (value: string) => {
  if (value.length === 0) throw new Error('secret was empty; validation should have caught this');
  return new Secret(value);
};

const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

const booleanish = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const integer = (fallback: number, min: number, max: number) =>
  z
    .string()
    .default(String(fallback))
    .transform((value, ctx) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        ctx.addIssue({ code: 'custom', message: `must be an integer between ${min} and ${max}` });
        return z.NEVER;
      }
      return parsed;
    });

const url = z.url({ protocol: /^https?$/ });

const rawSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    RUN_MODE: z.enum(RUN_MODES).default('all'),

    DATABASE_URL: z.string().default(''),

    DRAWBRIDGE_MASTER_KEY: z.string().default(''),
    DRAWBRIDGE_MASTER_KEY_ID: z.string().default('k1'),

    DISCORD_APPLICATION_ID: z.string().default(''),
    DISCORD_BOT_TOKEN: z.string().default(''),
    DISCORD_CLIENT_SECRET: z.string().default(''),
    DISCORD_REDIRECT_URI: url.default('http://localhost:8080/api/v1/auth/discord/callback'),

    ROOT_ADMIN_DISCORD_IDS: csv,

    PUBLIC_BASE_URL: url.default('http://localhost:8080'),
    TRUST_PROXY: z.string().default('none'),

    CITADEL_API_BASE_URL: url.default('http://127.0.0.1:3000/api/v1/'),
    CITADEL_PUBLIC_BASE_URL: url.default('https://ozfortress.com'),
    LOGSTF_BASE_URL: url.default('https://logs.tf'),

    S3_ENDPOINT: z.string().default(''),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().default('drawbridge'),
    S3_FORCE_PATH_STYLE: booleanish,
    S3_ACCESS_KEY_ID: z.string().default(''),
    S3_SECRET_ACCESS_KEY: z.string().default(''),

    ALERT_WEBHOOK_URL: z.string().default(''),

    DISCORD_SHARDING: z.enum(['off', 'manager']).default('off'),
    DISCORD_SHARD_COUNT: z.string().default('auto'),

    RETENTION_DAYS: integer(730, 1, 3650),

    WEB_HOST: z.string().default('0.0.0.0'),
    WEB_PORT: integer(8080, 1, 65535),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

    DEV_GUILD_ALLOWLIST: csv,
  })
  .superRefine((raw, ctx) => {
    // Tests and intentional smoke runs use Node's built-in placeholder values.
    if (raw.NODE_ENV === 'test') return;

    // Every mode touches Postgres; even migrate has to connect.
    if (raw.DATABASE_URL.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'is required in every run mode',
      });
    }

    const needsDiscordSecrets = raw.RUN_MODE !== 'migrate';
    if (needsDiscordSecrets) {
      if (raw.DISCORD_BOT_TOKEN.length < 10) {
        ctx.addIssue({
          code: 'custom',
          path: ['DISCORD_BOT_TOKEN'],
          message: 'is required (set it in .env.local or a Coolify locked variable)',
        });
      }
      if (raw.DISCORD_APPLICATION_ID.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['DISCORD_APPLICATION_ID'],
          message: 'is required',
        });
      }
    }
    if (raw.RUN_MODE === 'web' || raw.RUN_MODE === 'all') {
      if (raw.DISCORD_CLIENT_SECRET.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['DISCORD_CLIENT_SECRET'],
          message: 'is required for panel sign-in',
        });
      }
      if (raw.ROOT_ADMIN_DISCORD_IDS.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['ROOT_ADMIN_DISCORD_IDS'],
          message: 'needs at least one Discord user ID',
        });
      }
    }

    if (raw.DRAWBRIDGE_MASTER_KEY.length > 0) {
      const bytes = Buffer.from(raw.DRAWBRIDGE_MASTER_KEY, 'base64');
      if (bytes.length !== 32) {
        ctx.addIssue({
          code: 'custom',
          path: ['DRAWBRIDGE_MASTER_KEY'],
          message: 'must be base64 for exactly 32 bytes',
        });
      }
    }

    if (raw.S3_ENDPOINT.length > 0 && raw.S3_ACCESS_KEY_ID.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_ACCESS_KEY_ID'],
        message: 'is required when S3_ENDPOINT is set',
      });
    }
  });

export interface Config {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly runMode: RunMode;
  readonly databaseUrl: Secret;

  readonly masterKey: Secret | undefined;
  readonly masterKeyId: string;

  readonly discordApplicationId: string;
  readonly discordBotToken: Secret;
  readonly discordClientSecret: Secret;
  readonly discordRedirectUri: string;
  readonly rootAdminDiscordIds: readonly string[];
  readonly discordSharding: 'off' | 'manager';
  readonly discordShardCount: string;

  readonly publicBaseUrl: string;
  readonly trustProxy: string;

  readonly citadelApiBaseUrl: string;
  readonly citadelPublicBaseUrl: string;
  readonly logstfBaseUrl: string;

  readonly s3Endpoint: string;
  readonly s3Region: string;
  readonly s3Bucket: string;
  readonly s3ForcePathStyle: boolean;
  readonly s3AccessKeyId: Secret;
  readonly s3SecretAccessKey: Secret;

  readonly alertWebhookUrl: Secret | undefined;

  readonly retentionDays: number;

  readonly webHost: string;
  readonly webPort: number;
  readonly logLevel: LogLevel;

  readonly devGuildAllowlist: readonly string[];
}

function toConfig(raw: z.infer<typeof rawSchema>): Config {
  return {
    nodeEnv: raw.NODE_ENV,
    runMode: raw.RUN_MODE,
    databaseUrl: toSecret(raw.DATABASE_URL),

    masterKey: raw.DRAWBRIDGE_MASTER_KEY ? requiredSecret(raw.DRAWBRIDGE_MASTER_KEY) : undefined,
    masterKeyId: raw.DRAWBRIDGE_MASTER_KEY_ID,

    discordApplicationId: raw.DISCORD_APPLICATION_ID,
    discordBotToken: toSecret(raw.DISCORD_BOT_TOKEN || 'missing'),
    discordClientSecret: toSecret(raw.DISCORD_CLIENT_SECRET || 'missing'),
    discordRedirectUri: raw.DISCORD_REDIRECT_URI,
    rootAdminDiscordIds: raw.ROOT_ADMIN_DISCORD_IDS,
    discordSharding: raw.DISCORD_SHARDING,
    discordShardCount: raw.DISCORD_SHARD_COUNT,

    publicBaseUrl: raw.PUBLIC_BASE_URL,
    trustProxy: raw.TRUST_PROXY,

    citadelApiBaseUrl: raw.CITADEL_API_BASE_URL,
    citadelPublicBaseUrl: raw.CITADEL_PUBLIC_BASE_URL,
    logstfBaseUrl: raw.LOGSTF_BASE_URL,

    s3Endpoint: raw.S3_ENDPOINT,
    s3Region: raw.S3_REGION,
    s3Bucket: raw.S3_BUCKET,
    s3ForcePathStyle: raw.S3_FORCE_PATH_STYLE,
    s3AccessKeyId: toSecret(raw.S3_ACCESS_KEY_ID || 'missing'),
    s3SecretAccessKey: toSecret(raw.S3_SECRET_ACCESS_KEY || 'missing'),

    alertWebhookUrl: raw.ALERT_WEBHOOK_URL ? requiredSecret(raw.ALERT_WEBHOOK_URL) : undefined,

    retentionDays: raw.RETENTION_DAYS,

    webHost: raw.WEB_HOST,
    webPort: raw.WEB_PORT,
    logLevel: raw.LOG_LEVEL,

    devGuildAllowlist: raw.DEV_GUILD_ALLOWLIST,
  };
}

/** Thrown when the environment is invalid. The message lists every problem. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function parseConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Config {
  const result = rawSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  - ${path}: ${issue.message}`;
    });
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return toConfig(result.data);
}

export function loadConfig(): Config {
  return parseConfig(process.env);
}

/** A copy of the config with every secret replaced by its marker. */
export function redactedConfig(config: Config): Record<string, unknown> {
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}
