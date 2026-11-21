# Drawbridge v2 fleet handoff

Read this file, then `workstreams.md`, then `board.md`. The authoritative product and architecture plan lives outside the repo in the owner's plan folder (paths below); nothing in this repo replaces it.

## 1. Authoritative sources

| Source       | Path                                                                     | Use                                                                                              |
| ------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Product plan | `C:\Users\natha\.opencode\plan\drawbridge-v2\README.md` and `01` to `06` | Requirements, permissions, architecture, data model, parity matrix, phases, scheduling API v1/v2 |
| Repo docs    | `v2/docs/`                                                               | Implementation decisions, progress, runbook, privacy                                             |
| This handoff | `v2/docs/handoff/`                                                       | Fleet coordination, ownership, current state                                                     |

The plan folder is read-only for build agents. Implementation choices go in `v2/docs/decisions.md`; deviations from the plan are recorded there before they are made.

## 2. Repository and baseline

- Worktree: `E:\drawbridge-v2`
- Branch: `drawbridge-v2`
- Base: `9d231f1` (legacy Python tree on `main`)
- Commits:
  - `402ca42` P0 foundations
  - `db01586` P1 data, auth, RBAC and panel shell
  - handoff docs follow P1; use `git log --oneline` for the exact head
- Latest green state: `pnpm typecheck`, `pnpm lint`, `pnpm test` (85 tests), `pnpm build`.
- Runtime smoke verified: migrations applied, root admin seeded, panel served at `/signin`, `/api/v1/me` returns 401 without a session.
- Commits are currently unsigned because GPG pinentry times out. The owner will sign later. Build agents must commit with `git -c commit.gpgsign=false commit` and must not change git configuration.

## 3. What already exists

| Area                                           | Location                                   | Notes                                                     |
| ---------------------------------------------- | ------------------------------------------ | --------------------------------------------------------- |
| Env validation, secrets markers, log scrubbing | `v2/packages/config`                       | Zod, `Secret` wrapper, secret scope                       |
| Structured JSON logging                        | `v2/packages/logging`                      | Key redaction plus free-text scrubbing                    |
| Readiness model                                | `v2/packages/health`                       | `ok` / `degraded` / `down`                                |
| AES-256-GCM envelopes, tokens                  | `v2/packages/crypto`                       | AAD binds ciphertext to table/row/column; rotation helper |
| Tiers, capabilities, league rank rules         | `v2/packages/authz`                        | Pure, fully tested                                        |
| Postgres schema, migration, repos              | `v2/packages/db`                           | P1 tables only; later phases add tables                   |
| Test database helper                           | `v2/packages/testkit`                      | Creates `drawbridge_test`, migrates, truncates            |
| Fastify app, health, static panel, API routes  | `v2/apps/web`                              | Auth, users, leagues, audit                               |
| OAuth, sessions, CSRF, guards                  | `v2/apps/web/src/auth`, `src/http`         | Injected OAuth for tests                                  |
| React panel shell                              | `v2/apps/panel`                            | Sign-in, home, leagues, league detail, users, audit       |
| Role entry point, migrations, root bootstrap   | `v2/apps/server`                           | `RUN_MODE`: all, web, bot, worker, migrate                |
| Bot and worker stubs                           | `v2/apps/bot`, `v2/apps/worker`            | Idle until P3                                             |
| Docker, dev compose, CI                        | `v2/deploy`, `.github/workflows/v2-ci.yml` | CI runs Postgres 16 and integration tests                 |

Dependency direction: `domain` (pure, to be added) imports nothing from adapters. `apps/*` wire adapters. No app imports another app. See plan `02-architecture.md` §2.

## 4. Environment

| Item               | Value                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node / pnpm        | 24.14.0 / 12.16.1 (`corepack`)                                                                                                                                     |
| Local Postgres     | `docker compose -f deploy/compose.dev.yaml up -d postgres`; host `127.0.0.1:5433`, database `drawbridge`, user/password `drawbridge`                               |
| Test database      | `TEST_DATABASE_URL` or default `postgres://drawbridge:drawbridge@127.0.0.1:5433/drawbridge_test`; created on demand                                                |
| Local secrets      | `v2/.env.local` (gitignored). Contains the test bot token, OAuth client secret, root admin ID and master key. **Never print, copy, commit or inspect its values.** |
| Discord test guild | `1573554616371777546` (fresh, blank)                                                                                                                               |
| Test application   | `1573555530901880855`                                                                                                                                              |
| OAuth redirect     | `http://localhost:8080/api/v1/auth/discord/callback`                                                                                                               |
| Intents            | Server Members and Message Content enabled on the test app                                                                                                         |
| Panel              | built to `apps/panel/dist`, served by the web app; dev server on 5173 proxies `/api` to 8080                                                                       |

Live Discord writes are allowed **only** in the test guild. Destructive jobs in any other guild are forbidden. Never contact production Citadel or production Discord.

## 5. Verify the baseline before starting

```powershell
cd E:\drawbridge-v2\v2
pnpm install --frozen-lockfile
docker compose -f deploy/compose.dev.yaml up -d postgres
pnpm typecheck
pnpm lint
pnpm test          # expect 85 passing
pnpm build
```

Runtime check:

```powershell
$env:WEB_PORT=8099
node --env-file=.env.local apps/server/dist/main.js
# GET http://127.0.0.1:8099/healthz -> 200
# GET http://127.0.0.1:8099/signin  -> 200 (panel)
# GET http://127.0.0.1:8099/api/v1/me -> 401
```

If the integration tests are skipped, Postgres is unreachable. Do not treat skipped tests as passing.

## 6. Rules every agent follows

### 6.1 Worktree and branch model

Each agent works in its own worktree and branch. Never edit another agent's worktree.

```powershell
cd E:\drawbridge-v2
git worktree add E:\drawbridge-v2-ws-<letter> -b ws/<letter>-<name> drawbridge-v2
```

Before a pull request: rebase onto the latest `drawbridge-v2`, rerun all checks. PR target is `drawbridge-v2`. The integrator merges one PR at a time in dependency order (`board.md`) and reruns checks after each merge. Do not force-push `drawbridge-v2`.

If there is no usable remote, the integrator merges branches locally with `git merge --no-ff`.

### 6.2 File ownership (prevents most conflicts)

| Owner                  | Paths                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integrator (WS-A) only | `v2/package.json`, `v2/pnpm-workspace.yaml`, `v2/pnpm-lock.yaml` (via install), root `tsconfig*.json`, `v2/biome.json`, `v2/vitest.config.ts`, `.github/**`, `v2/deploy/**`, `v2/apps/web/src/app.ts`, `v2/apps/web/src/index.ts`, `v2/apps/server/src/*`, `v2/packages/db/src/schema.ts`, `v2/packages/db/drizzle/**`, `v2/packages/db/src/repos.ts`, `v2/docs/progress.md`, `v2/docs/decisions.md`, `v2/docs/handoff/**` |
| Each stream            | Its own package directory, including that package's `package.json` and `tsconfig*.json`                                                                                                                                                                                                                                                                                                                                    |
| WS-E (API)             | `v2/apps/web/src/routes/**`, `v2/apps/web/src/http/**`, `v2/apps/web/src/auth/**`, `v2/apps/web/test/**`                                                                                                                                                                                                                                                                                                                   |
| WS-F (panel)           | `v2/apps/panel/**`                                                                                                                                                                                                                                                                                                                                                                                                         |
| Everyone else          | Their new package under `v2/packages/<name>/**`                                                                                                                                                                                                                                                                                                                                                                            |

Need a change in someone else's file? Put a "Change request" section in your PR description naming the file and the exact edit. The owner applies it. Do not edit it yourself.

### 6.3 Schema and migrations are serialized

WS-B is the schema owner. Only WS-B generates migrations (`pnpm -F @drawbridge/db db:generate`). Another stream that needs tables writes a schema change request in its PR description (columns, constraints, indexes, why). The integrator lands schema PRs before feature PRs that depend on them. Never edit an applied migration; never hand-edit `drizzle/meta`.

### 6.4 Commits and PRs

- Conventional Commits, scoped to the package, for example `feat(jobs): lease heartbeat`.
- One logical change per PR. Title prefix with the stream: `[WS-C] feat(discord-ops): executor budgets`.
- PR body: linked phase and plan section, parity rows affected (`04-features.md`), what was tested, screenshots for UI, change requests, known gaps.
- Every PR must pass typecheck, lint, tests and build.
- Record decisions and deviations in the PR body; the integrator copies them into `docs/decisions.md`.

### 6.5 Definition of done

Same as plan `05-delivery.md` §6: parity met or deviation approved, tests (unit and integration), capability checks, audit rows, timeline events, error taxonomy mapping, no secrets in logs, no IDs as numbers, docs updated.

## 7. Coordination

- `board.md` is owned by the integrator. Agents read it; they do not edit it.
- Status is reported in the PR and in the agent's final message. The integrator updates the board after merges.
- Claim work by opening a draft PR early with the stream prefix, or by messaging the integrator. One active task per agent.
- Blockers: stop, leave the partial work on the branch with a draft PR, and state the blocker. Do not guess on owner decisions (GPG, TF2Esports, production target, style system).
- Daily rhythm: rebase in the morning, check the board, land one PR per agent per day where possible.

## 8. Known gaps to fix early

These are real and should be handled in the first week by the named stream:

1. **CI has not run on GitHub yet.** The Postgres service was added but never executed (no push). WS-L verifies the first run.
2. **No rate limiting** on the panel API. WS-E adds per-session and per-IP limits before P4.
3. **No guild claim flow** and no Discord role mapping UI. WS-E/WS-F in P11, but the schema exists.
4. **League role management endpoints** are missing (rank-rule enforcement exists in `authz`). WS-E in P11.
5. **No API schema/OpenAPI document.** WS-E can derive it from Zod later.
6. **Panel styling is plain CSS.** Tailwind/shadcn was deferred. Owner decision needed before P4.
7. **No Playwright E2E.** WS-L adds it with the first stable UI flow.
8. **Docker image not built locally.** CI builds it; WS-L verifies once CI runs.
9. **`settings_kv` is unused.** WS-B uses it for subsystem switches.
10. **S3 and Discord readiness checks are placeholders** (optional, down). WS-G and WS-C wire them.
11. **`pnpm` prints "Agent skills awaiting approval: @tanstack/react-router".** It is informational and did not block install or build. Do not approve new build scripts without review.
12. **Sessions assume `PUBLIC_BASE_URL` is accurate.** Behind the proxy it must be the external HTTPS URL, otherwise cookies are not `Secure`.

## 9. First week

| Day | Integrator                               | WS-B data/jobs             | WS-C discord       | WS-D citadel/domain     | WS-F panel                     | WS-L QA          |
| --- | ---------------------------------------- | -------------------------- | ------------------ | ----------------------- | ------------------------------ | ---------------- |
| 1   | Verify baseline, push branch, confirm CI | P3 schema request          | FakeDiscord + port | Citadel client skeleton | Design pass, Tailwind decision | CI verification  |
| 2   | Merge schema, add P3 tables              | Job engine state machine   | Executor budgets   | Fixtures + dev seed     | Jobs page mock                 | E2E scaffold     |
| 3   | Merge engine                             | Leases, retries, reconcile | Step operations    | Naming/plan domain      | Preview UI mock                | Load script stub |
| 4   | Merge executor                           | Revert, decisions          | Failure injection  | Preview API             | Wire preview                   | Security matrix  |
| 5   | Integration demo on test guild           | P3 exit evidence           | Live smoke         | P2 exit evidence        | Usability review               | Report           |

## 10. Owner decisions still open

- GPG signing (owner will sign commits at the end).
- TF2Esports: which endpoints, rate, browser or server, return of pre-cutover data (Q-T2 already answered: not needed), and agreement on v2-only changes.
- Production Coolify server confirmation (`sterling` presumed, `hammond` for dev).
- Sentry or equivalent (optional).
- Tailwind/shadcn versus the current plain CSS for the panel.
- Attachment size caps and legal hold defaults.
