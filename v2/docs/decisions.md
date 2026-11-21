# Decisions

Implementation decisions and deviations from the plan. Newest first.

## P2 (2026-11-22)

- **`previews` table added to the schema.** Plan `03` §2.4 did not name it; the preview-and-approve flow needs the plan and its Citadel snapshot stored against a hash. Columns per todo 10: `id uuid pk`, `league_id` (fk, cascade), `created_by_user_id` (fk, set null, nullable like the other creator columns), `plan`/`snapshot` jsonb not null, `plan_hash` text not null, `citadel_snapshot_at`/`expires_at`/`consumed_at` nullable timestamptz (lifecycle set by the API, not defaulted), `created_at`; index `(league_id, created_at desc)`. Previews are deliberately not unique: re-previewing stores a new row and the API layer treats consumed or expired rows as unusable.
- **No `guilds.capture_all_text`.** A6 forbids capture-all; capture stays scoped to rows in `managed_channels` only.
- **`leagues.citadel_league_id` stays `integer`.** Citadel league ids are Rails serials, so integer is sufficient; changing it would churn the P1 unique key for no precision gain.

## P1 (2026-11-22)

- **Snowflakes as strings end to end.** Postgres columns are `numeric(20,0)` (not `bigint`) so drivers and JSON never round them. Drizzle returns strings; no `BigInt` conversion at boundaries.
- **Sessions are opaque tokens.** 256-bit random token in an `HttpOnly` cookie; only the SHA-256 hash is stored. Idle timeout 12 hours, absolute 7 days. Cookie name is `__Host-drawbridge_session` over HTTPS and `drawbridge_session` over plain HTTP, because `__Host-` requires `Secure` and local development runs on HTTP.
- **CSRF is double-submit.** A readable `drawbridge_csrf` cookie plus an `x-csrf-token` header, compared with a constant-time check. Applied by a global preHandler to mutating `/api/v1` routes.
- **OAuth is injected.** `createDiscordOAuth` takes `fetchImpl`, so tests assert the authorize URL, token body, Basic auth and bearer user lookup without network access. The web app accepts an injected `oauth` for the same reason.
- **Capability checks are pure.** `@drawbridge/authz` holds tiers, the capability catalogue, default league templates and the rank rules, with a matrix test. The web layer resolves them against the database.
- **Invite consumption promotes only.** An invite never demotes an existing tier, and it is consumed once inside a transaction; it also inserts league memberships from its grants.
- **Users are never reactivated by sign-in.** `upsertDiscordUser` updates profile and last login only. Disabled accounts stay disabled and are refused at the callback.
- **Migration workflow.** drizzle-kit generates SQL into `packages/db/drizzle`; the `migrate` role and `RUN_MODE=all` apply it. Migrations are committed. Only one agent may generate a migration at a time (see the handoff document).
- **Test database.** Integration tests use `TEST_DATABASE_URL` (defaults to the local compose database on port 5433), create `drawbridge_test` on demand, and truncate between tests. `fileParallelism` is off because the files share one database. Tests skip when Postgres is unreachable; CI provides a service.
- **CI.** The `checks` job now runs a Postgres 16 service and sets `TEST_DATABASE_URL`, so integration tests run in CI rather than skipping.
- **Panel styling is plain CSS for now.** The plan names Tailwind and shadcn; installing them was deferred to keep P1 focused on auth and data. Revisit before P4 when the panel grows. Recorded as a deviation.
- **Panel is optional at runtime.** `buildApp({ servePanel: false })` keeps API-only tests deterministic; production serves `apps/panel/dist` with an SPA fallback. There is exactly one `setNotFoundHandler`.
- **Fastify's own logger stays off.** All request logging goes through the redacting logger. Health probes are not logged as requests.
- **pnpm 12 uses `allowBuilds`.** `pnpm-workspace.yaml` allows the `esbuild` build (needed by drizzle-kit and Vite). Do not approve other build scripts without review.

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
