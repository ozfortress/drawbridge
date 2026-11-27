# Task 24 — Jobs queue, detail, decisions and dashboard attention

**Date:** 2026-11-27
**Branch / worktree:** `ws/w20-jobs-ui` / `E:/drawbridge-wt/drawbridge-v2-redesign-implementation-w20`
**Base:** `19f729f`
**Artifacts:** `task-24-jobs-ui-exec/`

## Delivered

- Panel routes `/leagues/$leagueId/jobs` and `/jobs/$jobId`, using the existing layout, CSS tokens, tables, pills, notices and responsive wrappers.
- Queue columns: state, type, league, requested by and updated; state filter; loading, error and empty states; links between league, queue and detail.
- Detail metadata, failed-step/job taxonomy presentation, step journal, event journal, empty states and server-supplied decision actions.
- Retry, skip, adopt, revert and abort are rendered only from `allowedDecisions` returned by the API. Capability and state checks are not reimplemented in the client. `applyDecision` remains the mutation enforcement boundary.
- EventSource updates invalidate the active queue/detail/dashboard queries, paint a new job state immediately and close on unmount. The detail page also reconnects automatically through EventSource.
- Home dashboard needs-attention block: awaiting-decision jobs, unresolved alerts, recent jobs and leagues.
- League-scoped `GET /api/v1/leagues/:leagueId/alerts` repository/API path, plus requester and error fields on job responses. The web route reads through `@drawbridge/db`; it does not import Drizzle.
- Preview approval navigates to the new job detail.
- Playwright-driveable `data-testid` selectors cover pages, rows, states, filters, stream status, decisions, errors, steps, events and empty/loading states.

## Corrections and additions to the inherited work

1. Deleted `apps/web/test/jobs.integration.base-scratch.test.ts` and `tsconfig.scratch-task24.json`.
2. Fixed the two inherited lint errors (import ordering and test formatting).
3. Completed the alert integration fixture: the inherited test expected an alert but inserted none. It now covers open, resolved and foreign-league rows.
4. Added assertions that a helper with `jobs.decide` but without `tournament.destructive` is not offered a deleting revert, and that a terminal job has no allowed decisions.
5. Preserved the inherited plain `Record<string, unknown>` job/decision serializers; TypeScript completes without the earlier decision-union inference crash.
6. Browser QA exposed an SSE early-disconnect race not present in the inherited diff: disconnect handlers were attached only after awaiting Postgres `LISTEN`. Handlers now attach before that await, response close is covered, and a listener acquired after its client leaves is released immediately. `BuildAppOptions.streamListen` is a test-only injection seam; a deterministic regression holds acquisition until after abort and proves closure without sleeps or polling.

## Automated gates

All commands ran from `v2/` against real Postgres on `127.0.0.1:5433`; no integration test was skipped.

| Gate | Result | Evidence |
|---|---|---|
| `pnpm typecheck` | PASS, exit 0 | session output |
| `pnpm lint` | PASS, exit 0; no errors (93 informational diagnostics and one warning remain in the existing workspace output) | session output |
| `pnpm build` | PASS, exit 0; `tsc -b` and Vite production panel build | `task-24-jobs-ui-exec/gates-build.log` |
| `TEST_DATABASE_URL=...drawbridge_task24_abort_test pnpm exec vitest run apps/web/test/jobs.integration.test.ts` | PASS, **17/17** | session output |
| `TEST_DATABASE_URL=...drawbridge_task24_final pnpm test` | PASS, **42 files / 486 tests**, exit 0 | `task-24-jobs-ui-exec/full-tests-final.log` |

## Browser QA

**Surface:** production panel built by Vite and served with `vite preview` on `127.0.0.1:5173`; real `buildApp` on `127.0.0.1:8080`; Chrome 158 driven through the native DevTools Protocol; real Postgres 16 on port 5433. OAuth and Citadel were fakes. No production Citadel or Discord service was contacted and no live Discord write occurred.

Structured assertions are in `task-24-jobs-ui-exec/browser-qa.json`; the reproducible loopback harness is `qa24-server.mjs`. Desktop captures are 1440×1000 and mobile captures are 390×844. Checked mobile pages had `document.documentElement.scrollWidth === 390`; wide tables scroll inside `.table-wrap` rather than widening the page.

### Happy path and live updates

1. Signed in through the real session/CSRF flow with fake OAuth. Empty dashboard and queue states were present.
2. Created a league and stored its key through the real API, then built a preview through the panel: 2 divisions, 4 entries, 32 planned steps.
3. Approved the preview through `data-testid="approve-preview"`; the panel opened its queued job with 32 steps and only `decision-abort`, the legal queued-state action.
4. The QA transition driver moved the job queued → running → completed through the real database trigger/SSE path. The running selector matched in **24 ms** and completed in **47 ms**. A marker set on `window` survived both changes, proving no document refresh occurred.
5. After query refetch, the completed detail had 32 done steps, queued/started/completed journal events and the terminal-state message that no decisions were available.
6. Returned to the queue through the panel and reopened detail through its job link. The queue showed the five required columns and the completed state at both widths.

### Failure, capability/state-driven decisions and dashboard

1. A real `applyStepFailure` call injected a 401 into a running step. The job entered `awaiting_decision`, the step became `failed`, the error displayed the `fatal_config` taxonomy and the operator message, and an unresolved critical alert was written.
2. The enabled actions were exactly retry, skip step 1, adopt step 1, revert and abort. All five were visible and wrapped correctly on mobile.
3. Home showed one awaiting-decision job, one critical open alert, two recent jobs and the league.
4. Clicking retry moved the same document to `running`; the settled server response removed retry/skip/adopt and left only revert and abort, both enabled.
5. Integration tests separately prove that a caster without `jobs.decide` receives no decision choices and that a helper is not offered a deleting revert without `tournament.destructive`.

### Revoked session

Revoked the current session through the QA control, then reopened job detail. The panel redirected to `/signin`; a direct job API read in the same browser returned **401**. Desktop and mobile sign-in captures are included.

### Disconnect regression

Before the fix, SPA unmount closed the active listener but older early-aborted setup connections remained. After the fix, a fresh queue mount measured **0 → 1** Postgres listeners and immediate SPA navigation home returned it to **0**. The deterministic integration regression covers the same acquisition race.

## Screenshots

| Surface | Desktop | Mobile |
|---|---|---|
| Completed queue | `02-job-queue-desktop.png` | `03-job-queue-mobile.png` |
| Reopened completed detail | `04-job-detail-reopened-desktop.png` | `05-job-detail-reopened-mobile.png` |
| Failed job taxonomy | `06-job-failure-desktop.png` | `07-job-failure-mobile.png` |
| Failed job decision block | included in `06-job-failure-desktop.png` | `07b-job-failure-decisions-mobile.png` |
| Home needs attention | `08-home-needs-attention-desktop.png` | `09-home-needs-attention-mobile.png` |
| Revoked-session sign-in redirect | `10-revoked-session-signin-desktop.png` | `11-revoked-session-signin-mobile.png` |

Paths are relative to `task-24-jobs-ui-exec/`.

## Boundaries and risks

- The base predates the real step-executor wiring. For happy-path UI QA, the harness therefore drove running/completed transitions and done-step rows directly; the approval API, database trigger, SSE delivery, React Query updates and rendered outcome were real. The fatal path used the actual engine taxonomy function, not a hand-written response.
- The server-provided decision list is presentation data and can become stale between load and click; the engine re-checks every mutation. This is intentional and is covered by the existing decision refusal tests.
- Mobile queue/step/event tables intentionally require horizontal scrolling for their full column sets.
- Each active SSE connection consumes one Postgres listener connection. Early disconnect cleanup is now covered, but pool sizing at larger scale remains an operational consideration.
