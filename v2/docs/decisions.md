# Decisions

Implementation decisions and deviations from the plan. Newest first.

## P0 (2026-11-21)

- **Node 24 LTS, pnpm 12 via corepack.** Pinned in `.nvmrc`, `engines` and `packageManager`. CI reads the same files.
- **TypeScript 7.0.2.** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, ESM (`NodeNext`), project references, `tsc -b` at the root.
- **Vitest 5 with source aliases.** Tests import `@drawbridge/*` resolved to `src` (see `vitest.config.ts`), so `pnpm test` does not need a build first. Runtime in production uses built `dist`.
- **Biome 2.6** for lint and format. `noExplicitAny` and `noNonNullAssertion` are off. `noExplicitAny` must stay off only until the domain types land in P2.
- **Fastify 5.12** is the HTTP layer. Fastify's own logger is disabled; every request line goes through `@drawbridge/logging`, so redaction is uniform.
- **Own JSON logger instead of pino.** Requirements are JSON lines, levels, child bindings and redaction. A tiny implementation avoids a dependency and makes the `Secret` marker the primary mechanism. Two layers: `Secret` values print as `[secret]`, and sensitive key names (`token`, `secret`, `password`, `apikey`, `authorization`, `cookie`, `webhookurl`, ...) are redacted even for plain strings.
- **Config validation is strict.** `NODE_ENV=test` deliberately relaxes required secrets so CI can run without credentials. Every other mode fails fast with a list of field paths. `WEB_PORT` is coerced with integer bounds.
- **No `.env` loader dependency.** `pnpm dev:web` uses `node --env-file-if-exists=.env.local`. Deployed environments get real environment variables from Coolify.
- **Readiness is honest.** Until P3 the dependency list reports `postgres`, `s3` and `discord` as down but not required, so `/readyz` returns `degraded` (200) rather than a false `ok`. P1 makes `postgres` a real check.
- **Bot and worker idle instead of exiting.** They are stubs until P3. Exiting would cause restart loops in a supervisor.
- **One image, several roles.** `RUN_MODE` selects the role. `all` runs web, bot and worker in one process for development; production uses separate containers from the same image.
- **CI scope.** `.github/workflows/v2-ci.yml` triggers on `v2/**`, runs typecheck, lint, tests and build, then builds the Docker image without pushing.
