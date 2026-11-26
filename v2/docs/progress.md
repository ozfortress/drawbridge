# Progress

## Environment

- Node: 24.14.0
- pnpm: 12.16.1
- Docker: 29.8.2
- Git: 2.47.1.windows.2
- Branch: drawbridge-v2
- Worktree: E:\drawbridge-v2
- Main baseline: 9d231f1
- Plan: C:\Users\natha\.opencode\plan\drawbridge-v2 (outside the repo)

## Phases

- [x] P0 Foundations
- [x] P1 Data, crypto, identity, RBAC, panel shell
- [x] P2 Citadel client, league import, preview (exit checks recorded 2026-11-26)
- [ ] P3 Job engine and Discord executor
- [ ] P4 Tournament setup parity
- [ ] P5 Match lifecycle parity
- [ ] P6 Capture, attachments, timeline, legacy logs
- [ ] P7 logs.tf and demo checks
- [ ] P8 Scheduling parity
- [ ] P9 Awards parity
- [ ] P10 Sync, FAQ, templates
- [ ] P11 Multi-guild, self-hosting, scale readiness
- [ ] P12 Cutover

## State

- 441 tests pass across 39 files: unit (config, logging, health, crypto, authz, citadel client/schemas/contract, testkit, job state machine, error taxonomy, retry policy, signal-aware loop wait, Discord operation catalogue and port contract, DiscordExecutor budgets/lanes/preflight) and integration (repositories, seed, HTTP API, preview, job claims/leases/reconciliation, failure application and pause/probe, decisions, revert, scheduled operations, worker loop, worker role wiring) against Postgres 16.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm -F @drawbridge/db db:check` are green.
- P3 job engine: schema and journal (todo 14), pure state machine (todo 15), queue claims, leases and reconciliation (todo 16), retry policy, error taxonomy, external pause/probe, decisions and revert with reverting-state lease recovery (todo 17), the scheduled-operation driver plus worker loop started from the worker role with graceful shutdown (todo 18), the plain-data Discord port with its idempotent operation catalogue (todo 19), and the DiscordExecutor with its budgets, lanes, preflight and taxonomy failure surface (todo 20) are done; the step executor wiring over the executor and the live test-guild smoke are the remaining P3 work.
- P2 exit checks recorded 2026-11-26 (five checks, none skipped): golden plan equality (byte + value), hidden league `citadel_not_visible`, injected Citadel 503 with no partial preview, 18-digit snowflake round-trip through Citadel/Postgres/API/panel with a failure probe, and a manual run against the live Citadel dev stack. Evidence: `.omo/evidence/drawbridge-v2-redesign-implementation/task-13-p2-exit.md` (outside the repo).
- Runtime smoke: migrations applied, root admin seeded, panel served at `/signin`, `/api/v1/me` returns 401 without a session.
- Local Postgres: `docker compose -f deploy/compose.dev.yaml up -d postgres` (host port 5433). Integration tests create `drawbridge_test` and truncate between tests.

## Open blockers

- TF2Esports questions (`06` §6): Q-T1, Q-T3 to Q-T7 open. Q-T2 answered: no pre-cutover schedule data.
- B8 (optional): error tracking choice.
- Production server `sterling` presumed, to be confirmed.

## Assumptions acted on

- A1 root-only for admins: admin tier cannot change root or other admins.
- A5/A21 trimming: implemented in P2's naming module.
- A6 managed-channel capture: `managed_channels` table exists; capture in P6.
- A13 archive in place, delete as a separate action: state in the plan and ledger design.
- A19 demo check repeat: P7.
- A20 league hierarchy: ranked roles with capabilities, implemented in authz and the schema.
- A22 expiring attachment URLs: P6.
- A23 dev on hammond, production presumed sterling: deploy docs.
- A24 scheduling v1 frozen, v2 under /api/v2: P8.

## Last session

- Date: 2026-11-26
- Done: P2. Citadel client with contract tests, FakeCitadel, dev seed, domain naming/access/capacity/plan with a golden file, preview API with stored snapshot and drift check, live preview panel screen and dev seed. P2 exit checks recorded (golden equality, hidden league, injected 503, 18-digit snowflake round-trip with failure probe, live manual run against the Citadel dev instance); P2 marked done. Commits are signed with key 60BB6FE8E7073C6B.
- Next: P3. Job engine and Discord executor.
