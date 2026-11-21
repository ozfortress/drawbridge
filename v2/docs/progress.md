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
- [ ] P2 Citadel client, league import, preview
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

- 85 tests pass: unit (config, logging, health, crypto, authz) and integration (repositories, HTTP API) against Postgres 16.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` are green.
- Runtime smoke: migrations applied, root admin seeded, panel served at `/signin`, `/api/v1/me` returns 401 without a session.
- Local Postgres: `docker compose -f deploy/compose.dev.yaml up -d postgres` (host port 5433). Integration tests create `drawbridge_test` and truncate between tests.

## Open blockers

- GPG signing is pending the owner's key unlock. Commits are unsigned; owner can sign later.
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

- Date: 2026-11-22
- Done: P1. Postgres/Drizzle schema and migration for identity, guilds, leagues, roles, memberships, managed channels, audit, alerts, settings. AES-256-GCM crypto with key ids and AAD, token hashing. Discord OAuth (injectable fetch), server-side sessions, CSRF, capability guards, user/invite/tier management, league create/read/update, audit. React panel shell (sign-in, home, leagues, league detail, users, audit). CI now has a Postgres service and runs integration tests.
- Next: P2. Citadel client, dev seed, domain naming/plan builder, preview.
