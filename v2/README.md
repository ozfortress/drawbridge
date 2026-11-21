# Drawbridge v2

TypeScript rewrite of Drawbridge. The build plan lives outside the repository, in the owner's plan folder (`drawbridge-v2/`). Everything in this directory implements phase P0 onward of that plan.

## Layout

| Path               | Purpose                                                |
| ------------------ | ------------------------------------------------------ |
| `packages/config`  | Bootstrap environment parsing (Zod), secret markers    |
| `packages/logging` | Structured JSON logging with redaction                 |
| `packages/health`  | Readiness model and dependency checks                  |
| `apps/web`         | Fastify HTTP API and panel host (panel arrives in P1)  |
| `apps/bot`         | Discord gateway, interactions, capture (stub until P3) |
| `apps/worker`      | Job runner and pipelines (stub until P3)               |
| `apps/server`      | `RUN_MODE` entry point that supervises the roles       |
| `deploy`           | Dockerfile, dev compose                                |
| `docs`             | Progress, decisions, runbook, privacy                  |

## Local development

```bash
cp .env.example .env.local   # fill in the Discord credentials
pnpm install
pnpm build
pnpm test
pnpm dev:web                 # http://localhost:8080/healthz
```

`pnpm dev:web` requires `.env.local`. The bot and worker logs are silent no-ops until P3.

Postgres and MinIO for integration work (P1 and later):

```bash
docker compose -f deploy/compose.dev.yaml up -d postgres minio
```

Postgres is exposed on host port **5433**, because the Citadel dev instance owns 5432.

## Configuration

Bootstrap values only. Leagues, channels, templates, FAQ text and per-league Citadel keys are configured in the panel and stored in the database. See `.env.example`; secrets are marked in comments there.

`RUN_MODE` is one of `all`, `web`, `bot`, `worker`, `migrate`. Production runs `web`, `bot` and `worker` as separate containers from the same image.

## Health

- `GET /healthz`: liveness.
- `GET /readyz`: readiness. `503` when a required dependency is down.

Until P3 the dependencies report as `down` with `required: false`, so readiness is `degraded` rather than `down`. This is deliberate: a missing check is visible, not mistaken for a healthy dependency.

## Deployment

The image is built from `deploy/Dockerfile`. The app does not terminate TLS: put a reverse proxy (Coolify Traefik or another) in front of it and set `PUBLIC_BASE_URL` and `TRUST_PROXY`. See the plan's architecture section 14.

## Testing

Vitest. `pnpm test` runs unit tests. Integration tests with real Postgres and MinIO arrive with P1.

## Documentation

- `docs/README.md`: index
- `docs/progress.md`: phase status
- `docs/decisions.md`: implementation decisions and the assumptions acted on
