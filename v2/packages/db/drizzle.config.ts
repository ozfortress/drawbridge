import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
  dbCredentials: {
    url:
      process.env['DATABASE_URL'] ?? 'postgres://drawbridge:drawbridge@127.0.0.1:5433/drawbridge',
  },
});
