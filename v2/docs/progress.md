# Progress

## Environment

- Node: 24.14.0
- pnpm: 12.16.1
- Docker: 29.8.2
- Git: 2.47.1.windows.2
- Branch: drawbridge-v2 @ (first commit pending)
- Worktree: E:\drawbridge-v2
- Main baseline: 9d231f1
- Plan: C:\Users\natha\.opencode\plan\drawbridge-v2 (outside the repo)

## Phases

- [x] P0 Foundations
- [ ] P1 Data, crypto, identity, RBAC, panel shell
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

## Open blockers

- B8 (optional): error tracking choice.
- TF2Esports questions (`06` §6): Q-T1, Q-T3 to Q-T7 open. Q-T2 answered: no pre-cutover schedule data.

## Assumptions acted on

- A1 root-only for admins: admin tier cannot change root or other admins.
- A5/A21 trimming: implemented in P2's naming module.
- A6 managed-channel capture: schema in P1, capture in P6.
- A13 archive in place, delete as a separate action: ledger state supports it from P3.
- A19 demo check repeat: P7.
- A20 league hierarchy: schema in P1, management in P11.
- A22 expiring attachment URLs: P6.
- A23 dev on hammond, production presumed sterling: deploy docs.
- A24 scheduling v1 frozen, v2 under /api/v2: P8.

## Last session

- Date: 2026-11-21
- Done: P0. Branch and worktree created. Monorepo scaffold: config, logging, health, web, bot and worker stubs, run-mode server, Dockerfile, dev compose, CI. Verification: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.
- Next: P1. Drizzle schema for identity, guilds, leagues and audit; crypto envelopes; Discord OAuth; RBAC; panel shell.
