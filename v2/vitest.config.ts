import { fileURLToPath } from 'node:url';

const pkg = (name: string): string =>
  fileURLToPath(new URL(`packages/${name}/src/index.ts`, import.meta.url));
const app = (name: string): string =>
  fileURLToPath(new URL(`apps/${name}/src/index.ts`, import.meta.url));

export default {
  resolve: {
    alias: {
      '@drawbridge/config': pkg('config'),
      '@drawbridge/domain': pkg('domain'),
      '@drawbridge/citadel': pkg('citadel'),
      '@drawbridge/logging': pkg('logging'),
      '@drawbridge/health': pkg('health'),
      '@drawbridge/crypto': pkg('crypto'),
      '@drawbridge/authz': pkg('authz'),
      '@drawbridge/db': pkg('db'),
      '@drawbridge/jobs': pkg('jobs'),
      '@drawbridge/discord-ops': pkg('discord-ops'),
      '@drawbridge/testkit': pkg('testkit'),
      '@drawbridge/web': app('web'),
      '@drawbridge/bot': app('bot'),
      '@drawbridge/worker': app('worker'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    // Integration files share one Postgres database and truncate between tests.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      thresholds: {
        'packages/citadel/src/**': { lines: 75 },
        'packages/domain/src/**': { lines: 90 },
        'packages/jobs/src/**': { lines: 90 },
      },
    },
  },
};
