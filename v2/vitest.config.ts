import { fileURLToPath } from 'node:url';

const pkg = (name: string): string =>
  fileURLToPath(new URL(`packages/${name}/src/index.ts`, import.meta.url));
const app = (name: string): string =>
  fileURLToPath(new URL(`apps/${name}/src/index.ts`, import.meta.url));

export default {
  resolve: {
    alias: {
      '@drawbridge/config': pkg('config'),
      '@drawbridge/logging': pkg('logging'),
      '@drawbridge/health': pkg('health'),
      '@drawbridge/web': app('web'),
      '@drawbridge/bot': app('bot'),
      '@drawbridge/worker': app('worker'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
};
