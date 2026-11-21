# Workstreams

Each stream has a mission, owned paths, dependencies, and phase exit criteria. Phases refer to the plan (`05-delivery.md`). Read your stream plus `README.md` and the relevant plan sections before starting.

## WS-A: Integrator and release

**Mission:** Keep `drawbridge-v2` green and merge the fleet in dependency order.

**Owns:** shared root configs, lockfile updates, `apps/web/src/app.ts`, `apps/web/src/index.ts`, `apps/server/src/*`, `packages/db/src/schema.ts`, `packages/db/src/repos.ts`, `packages/db/drizzle/**`, `.github/**`, `deploy/**`, `docs/progress.md`, `docs/decisions.md`, `docs/handoff/**`.

**First tasks**

1. Verify the baseline (see `README.md` §5). Push `drawbridge-v2` and confirm CI runs with the Postgres service.
2. Publish `board.md` and assign streams.
3. Serialize schema changes: collect requests, have WS-B generate one migration per intake, merge schema PRs first.
4. Merge in the order in `board.md`, rerunning typecheck, lint, tests and build after each merge.
5. Keep `docs/progress.md` and `docs/decisions.md` current. Copy PR decisions into the decisions file.
6. Own the risk register and the owner status report.

**Exit:** `drawbridge-v2` is green after every merge; no unsigned conflict markers; owner has a weekly status.

## WS-B: Data and job engine

**Mission:** Own the schema and the job engine (the journal) that makes every multi-step operation resumable.

**Owns:** `packages/db` (schema and repos, with the migration protocol), new `packages/jobs`, `packages/testkit` extensions for the job engine.

**Depends on:** P1 baseline. Unblocks WS-C, WS-E, WS-G, WS-I.

**Plan refs:** `02` §5, `03` §2.3–2.4, `05` P3.

**First tasks**

1. Schema request: `jobs`, `job_steps`, `job_events`, `discord_objects`, `channel_repairs` (P3 set). Then divisions, entries, captains, matches (P4 set) when WS-D is ready.
2. Job engine: states and transitions, leases and heartbeats, `SKIP LOCKED` claims, retry policy and taxonomy, pause and resume, awaiting-decision flow, revert and compensation, reconciliation by audit reason tag.
3. Per-league advisory lock and active-duplicate guard.
4. Scheduler for maintenance jobs (deadline, retention, reconcile, launchpad refresh).
5. Idempotent DB writes and unique keys.
6. Failure-injection tests for the engine half: lease expiry, pause recovery, revert, duplicate approval.

**Exit (P3 engine):** failure scenarios 1, 2, 3, 4, 7, 8, 9 pass; engine exposes metrics; docs updated.

## WS-C: Discord executor and gateway

**Mission:** Make every Discord write a journaled, budgeted step, and receive gateway events.

**Owns:** new `packages/discord-ops` (port, operations, executor, FakeDiscord), later `apps/bot` gateway wiring in coordination with WS-G.

**Depends on:** WS-B job engine. Uses the test guild (owner-provided credentials).

**Plan refs:** `02` §4, §5, `05` P3.

**First tasks**

1. Define `DiscordPort` and the step operations: create/delete role, category, text channel; overwrites with prior state captured; send/pin; add/remove role; move/rename. Each operation returns created IDs and a compensation.
2. `DiscordExecutor`: per-guild concurrency, global rate, lanes, 429 `retry_after`, 401 stop-all, error taxonomy mapping, preflight (permissions, hierarchy, capacity).
3. FakeDiscord with realistic snowflakes, overwrites, hierarchy, limits, audit reasons, error injection, gateway emitter.
4. Failure injection: crash between create and ledger, 403, 30013, 429, 401.
5. Live smoke on the test guild: create three objects and revert, recorded.

**Exit:** plan `05` §3.4 scenarios 1, 5, 6, 10, 11 pass; smoke recorded; docs updated.

## WS-D: Citadel client, fixtures, domain planning

**Mission:** Read Citadel safely and turn a league into a deterministic, previewable plan.

**Owns:** new `packages/citadel`, new `packages/domain`, `tools/citadel-dev`, P2 preview routes (coordinate with WS-E; WS-E owns `apps/web/src/routes`).

**Depends on:** P1 baseline, local Citadel dev instance.

**Plan refs:** `02` §6, `04` §8, `05` P2.

**First tasks**

1. Citadel client for the seven GET endpoints, lossless JSON (18-digit IDs must round-trip), Zod schemas, error mapping, cache, circuit breaker, concurrency limit.
2. Fetch contract fixtures from the local Citadel dev instance; sanitise and commit.
3. Citadel dev seed (`tools/citadel-dev/seed.rb`, manifest) per plan `05` §1.1. Two divisions, eight rosters each, hidden league, captains via `grant(:edit, team)`, matches in every status, at least one bye, 18-digit Discord IDs.
4. Pure domain: divisions/entries/captains, naming (A5/A21), access sets and overwrite plan, capacity planner.
5. Preview pipeline: snapshot the Citadel data used, capacity and permission checks, plan hash.
6. Golden plan test from the seeded league.

**Exit (P2):** golden plan matches; hidden league maps to `citadel_not_visible`; 503 leaves no partial data; ID round-trip test; owner sees one live dev-instance run recorded.

## WS-E: Web API, auth and RBAC

**Mission:** Own the HTTP surface and authorization beyond what P1 shipped.

**Owns:** `apps/web/src/routes/**`, `apps/web/src/http/**`, `apps/web/src/auth/**`, `apps/web/test/**`. Coordinates `app.ts` changes with WS-A.

**Depends on:** P1; WS-B for job endpoints; WS-D for preview.

**Plan refs:** `01` §3, `02` §8, §11, `05` P1/P3/P8/P11.

**First tasks**

1. Rate limits (session and IP) and request size limits.
2. Job endpoints: list, detail, decision, cancel, SSE stream.
3. League hierarchy endpoints: list/create/update/reorder roles, assign/remove members, enforcing rank rules from `authz`.
4. Guild claim and role mapping endpoints (P11).
5. Scheduling API v1 (golden responses from legacy) and v2 routes per `06`.
6. OpenAPI/Swagger from Zod schemas (optional but useful for the fleet).

**Exit:** authorization matrix covers every route and tier; rate limits tested; job endpoints exercised by WS-F.

## WS-F: Panel

**Mission:** Turn the API into a usable admin surface.

**Owns:** `apps/panel/**`.

**Depends on:** P1 shell; API additions from WS-E and WS-B.

**Plan refs:** `05` P4/P5/P6/P11, `04` §5.

**First tasks**

1. Design pass: confirm Tailwind/shadcn with the owner (currently plain CSS).
2. Jobs pages: queue, detail with steps and events, decisions, live updates via SSE.
3. Setup wizard: preview, approve, progress, revert.
4. Match timeline: filters, attachment previews, exports.
5. Users/league staff management, guild claim, role mapping, capacity warnings.
6. Error, empty and loading states for every page.

**Exit:** P4/P5 flows usable end to end on the test guild; accessibility and keyboard basics checked.

## WS-G: Capture, storage, timeline and retention

**Mission:** Record everything that matters in managed channels, keep it for two years, and make it viewable.

**Owns:** new `packages/capture`, new `packages/storage`, gateway capture wiring in `apps/bot`, retention tables/helpers (schema via WS-B), timeline queries.

**Depends on:** WS-B, WS-C (gateway events), WS-E for timeline endpoints.

**Plan refs:** `02` §9, `03` §2.5, `05` P6.

**First tasks**

1. Gateway capture: message create/update/delete/bulk, reactions (add/remove/remove-all/remove-emoji), revisions, single-transaction writes.
2. Managed-channel resolution and `capture.backfill`.
3. Affiliation snapshot from match context, Citadel roster cache and Discord roles.
4. Attachment pipeline: CDN host allowlist, size caps, SHA-256 dedupe, S3, thumbnails, video transcode (A12), 24-hour retry, presigned downloads.
5. Timeline API and UI handoff to WS-F; exports (JSON, CSV, transcript); redaction.
6. Retention job with dry run, partition management, blob garbage collection.
7. Legacy MariaDB import tool (`tools/legacy-import`) with synthetic fixture and dry-run report.

**Exit (P6):** load test at 100 msg/s for five minutes with no loss; timeline p95 under 300 ms on 1M events; dedupe and transcode cases; retention dry run exact.

## WS-H: logs.tf and demo checks

**Mission:** Cache logs.tf, verify submissions, render scoreboards, run demo checks.

**Owns:** new `packages/logstf`, demo-check domain and routes (coordinate WS-E).

**Depends on:** WS-B (jobs), WS-G (attachments) for scoreboard images.

**Plan refs:** `02` §10, `04` rows 17–19, `05` P7.

**First tasks**

1. Client and cache (`logstf_logs`), coalescing concurrent fetches, limiters.
2. Summary mapping and verification against roster Steam3 IDs.
3. SVG/PNG scoreboard renderer with the legacy icon and font assets; golden images.
4. Auto-embed, winner announcement, anti-spam; submission button and duplicate policy; demo check (optional logs-verified picks, no repeat per round).

**Exit:** golden scoreboards match; one upstream call per burst; not-found cached 10 minutes; demo check event recorded.

## WS-I: Scheduling and TF2Esports API

**Mission:** Scheduling parity, and the frozen v1 API plus a documented v2 for TF2Esports.

**Owns:** new `packages/scheduling`, `apps/web/src/routes/scheduling.ts` (coordinate WS-E), `docs/api/scheduling-v2.md`.

**Depends on:** P5 match channels; WS-B for deadline jobs; WS-E for route registration.

**Plan refs:** `02` §11, `04` rows 20–24, `06-scheduling-api-v2.md`, `05` P8.

**First tasks**

1. Capture golden v1 responses from the legacy code with a fixture database; write contract tests.
2. v1 routes: health, league settings, matches, match detail, overdue, set. Same paths, shapes, statuses, error bodies and CORS (allow `X-API-Key`).
3. v2 routes per `06` §5 behind flags.
4. Discord propose/confirm/counter/reschedule; deadline job; launchpad overdue section.
5. Scoped API keys stored as hashes; per-league read opt-in; rate limits and cache headers.

**Exit:** v1 contract tests green; scenario tests (propose/counter/confirm, deadlines, DST); owner sends `06` §6 to TF2Esports and records answers.

## WS-J: Awards

**Mission:** Nominations, ranked voting, IRV results and admin controls.

**Owns:** new `packages/awards`, award routes/UI handoff, schema requests to WS-B.

**Depends on:** P1; independent of the Discord executor for pure logic.

**Plan refs:** `04` rows 25–29, `05` P9.

**First tasks**

1. Port IRV from `web/irv.py`; generate golden results from the legacy code for at least 200 ballot sets including ties.
2. Tables and lifecycle phases; nominations (modal, paging); ranked votes; admin fills; invalidation; audit.
3. Persistent per-team components; captain check; notifications.
4. Panel pages.

**Exit:** IRV parity on all goldens; full dry-run event on the test guild.

## WS-K: Sync, FAQ and templates

**Mission:** Account linking, FAQ documents and editable message templates.

**Owns:** new `packages/sync`, FAQ/template routes (coordinate WS-E), panel pages (coordinate WS-F).

**Depends on:** P4 (team roles), P1.

**Plan refs:** `04` rows 30–33, `05` P10.

**First tasks**

1. Sync button and commands; `citadel_links`; captain assignment via the job; opt-in on-join sync; sync log channel.
2. FAQ documents per league and audience, revisions, `/faq`, Discord-safe chunking.
3. DB-backed templates with validation against Discord embed limits and a live preview.

**Exit:** sync scenarios (linked, unlinked, captain of two teams, absent); 20,000-character FAQ renders; templates reject oversize embeds.

## WS-L: QA, CI, performance and docs

**Mission:** Keep quality measurable and the fleet unblocked.

**Owns:** test strategy execution, Playwright, load scripts, CI workflow proposals (integrator applies), `docs/runbook.md`, `docs/privacy.md`, self-hosting docs.

**Depends on:** all streams.

**First tasks**

1. Confirm the first GitHub Actions run (Postgres service, integration tests, panel build, Docker).
2. Playwright on the compose stack for sign-in, invite, preview, job decision, timeline.
3. Load scripts: capture throughput, timeline latency, 50-guild FakeDiscord run.
4. Security checks: authorization matrix coverage report, CSRF, cookie flags, SSRF allowlist, export path traversal, secret redaction, dependency audit.
5. Runbook, privacy, self-hosting and backup/restore drill (P11/P12).

**Exit:** required checks are green and enforced; failure and chaos suites run; docs reviewed by the owner.
