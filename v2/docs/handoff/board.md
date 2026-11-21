# Coordinator board

Owned by the integrator (WS-A). Agents read this; they do not edit it. Report status in your PR and final message.

Baseline: `drawbridge-v2` at `db01586` (P1), plus the handoff docs on top. Last updated: 2026-11-22.

## Status

| Stream | Mission                                         | Status  | Owner      | Branch / PR     | Depends on                |
| ------ | ----------------------------------------------- | ------- | ---------- | --------------- | ------------------------- |
| WS-A   | Integrate, release, shared files, schema intake | active  | integrator | `drawbridge-v2` | -                         |
| WS-B   | Data and job engine                             | ready   | -          | -               | P1                        |
| WS-C   | Discord executor and gateway                    | blocked | -          | -               | WS-B engine               |
| WS-D   | Citadel, fixtures, domain planning              | ready   | -          | -               | P1, local Citadel         |
| WS-E   | Web API, auth, RBAC                             | ready   | -          | -               | P1; WS-B for jobs API     |
| WS-F   | Panel                                           | ready   | -          | -               | P1; mocks until APIs land |
| WS-G   | Capture, storage, timeline, retention           | blocked | -          | -               | WS-B, WS-C gateway        |
| WS-H   | logs.tf and demo checks                         | ready   | -          | -               | P1; WS-G for images       |
| WS-I   | Scheduling and TF2Esports API                   | blocked | -          | -               | P5                        |
| WS-J   | Awards                                          | ready   | -          | -               | P1                        |
| WS-K   | Sync, FAQ, templates                            | blocked | -          | -               | P4                        |
| WS-L   | QA, CI, performance, docs                       | ready   | -          | -               | all (continuous)          |

Legend: `ready` can start now; `blocked` waits for a dependency; `active` has work in flight.

## Merge order and critical path

```
P1 (done)
 ├─ WS-D  P2 Citadel + domain + preview
 ├─ WS-B  P3 schema + job engine
 │    └─ WS-C  P3 Discord executor
 │         └─ P4 setup (needs B, C, D)
 │              ├─ P5 matches
 │              │    └─ WS-I P8 scheduling
 │              └─ WS-K P10 sync/FAQ/templates
 ├─ WS-E  API hardening (continuous)
 ├─ WS-F  Panel (continuous, mocks first)
 ├─ WS-G  P6 capture/storage (needs B, C)
 │    └─ WS-H P7 logs.tf/demo
 ├─ WS-J  P9 awards (independent)
 └─ WS-L  QA/CI/perf/docs (continuous)
```

Merge policy: schema PRs first, then engine, then executor, then feature PRs that depend on them. One PR at a time. Rerun all checks after each merge.

## Merge queue

| Order | Stream | Contents                                                 | State   |
| ----- | ------ | -------------------------------------------------------- | ------- |
| 1     | WS-B   | P3 schema request (jobs, steps, events, ledger, repairs) | waiting |
| 2     | WS-D   | `packages/citadel` + fixtures + dev seed                 | waiting |
| 3     | WS-D   | `packages/domain` naming/plan/capacity + preview API     | waiting |
| 4     | WS-B   | Job engine                                               | waiting |
| 5     | WS-C   | `packages/discord-ops` + FakeDiscord + executor          | waiting |
| 6     | WS-E   | Job API, SSE, rate limits                                | waiting |
| 7     | WS-F   | Jobs + preview UI                                        | waiting |
| 8     | WS-L   | CI verification, Playwright scaffold                     | waiting |

## Active claims

| Agent | Stream | Claim | Since | Expected PR |
| ----- | ------ | ----- | ----- | ----------- |
| -     | -      | -     | -     | -           |

## Change requests

Agents append a "Change request" section to their PR description. The integrator records accepted changes here and applies them in the owning file.

| Date | From | File | Change | State |
| ---- | ---- | ---- | ------ | ----- |
| -    | -    | -    | -      | -     |

## Escalations (owner input needed)

| Topic       | Question                                                         | State |
| ----------- | ---------------------------------------------------------------- | ----- |
| GPG         | Owner will sign commits later; unsigned until then               | open  |
| TF2Esports  | Endpoints, frequency, browser or server, v2 acceptance (`06` §6) | open  |
| Production  | Confirm `sterling` as production target                          | open  |
| Panel style | Tailwind/shadcn or keep plain CSS                                | open  |
| Sentry      | Error tracking vendor or logs/webhook only                       | open  |

## Daily integrator checklist

1. Rebase `drawbridge-v2`; confirm CI.
2. Merge the next queue item; rerun `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.
3. Update `docs/progress.md` and this board.
4. Copy decisions from the merged PR into `docs/decisions.md`.
5. Report blockers to the owner; unblock streams by reprioritising the queue.
