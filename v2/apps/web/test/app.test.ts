import { parseConfig } from '@drawbridge/config';
import type { Dependency } from '@drawbridge/health';
import { createLogger } from '@drawbridge/logging';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

const config = parseConfig({ NODE_ENV: 'test' });

function captureLines(): { lines: string[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'debug',
    sink: (line: string) => lines.push(line),
  });
  return { lines, logger };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

async function makeApp(dependencies?: Dependency[]) {
  const { lines, logger } = captureLines();
  const ctx = await buildApp({
    config,
    logger,
    ...(dependencies ? { readinessDependencies: dependencies } : {}),
  });
  app = ctx.app;
  return { app: ctx.app, lines };
}

describe('GET /healthz', () => {
  it('reports liveness', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('drawbridge');
    expect(body.role).toBe('all');
    expect(typeof body.version).toBe('string');
    expect(typeof body.time).toBe('string');
  });
});

describe('GET /readyz', () => {
  it('is 200 and ok when every dependency answers', async () => {
    const { app } = await makeApp([{ name: 'postgres', required: true, check: async () => true }]);
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.dependencies).toEqual([
      expect.objectContaining({ name: 'postgres', status: 'ok', required: true }),
    ]);
  });

  it('is 503 and down when a required dependency fails', async () => {
    const { app } = await makeApp([
      {
        name: 'postgres',
        required: true,
        check: async () => {
          throw new Error('connection refused');
        },
      },
    ]);
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('down');
    expect(body.dependencies[0].reason).toBe('connection refused');
  });

  it('exposes unimplemented checks instead of pretending they are healthy', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.dependencies.map((d: { name: string }) => d.name)).toEqual([
      'postgres',
      's3',
      'discord',
    ]);
  });
});

describe('HTTP surface', () => {
  it('answers unknown routes with a JSON 404', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'Not found', path: '/nope' });
  });

  it('sets x-request-id on every response', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('never writes the authorization header or cookies to logs', async () => {
    const { app, lines } = await makeApp();
    await app.inject({
      method: 'GET',
      url: '/nope',
      headers: {
        authorization: 'Bearer super-secret-bearer',
        cookie: 'drawbridge_session=super-secret-cookie',
      },
    });
    const joined = lines.join('\n');
    expect(joined).not.toContain('super-secret-bearer');
    expect(joined).not.toContain('super-secret-cookie');
  });

  it('does not leak internal error messages to the caller', async () => {
    const { app } = await makeApp();
    app.get('/boom', async () => {
      throw new Error('database password is hunter2');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
    expect(res.json().error).toBe('Internal server error');
  });

  it('skips request logging for health probes', async () => {
    const { app, lines } = await makeApp();
    await app.inject({ method: 'GET', url: '/healthz' });
    await app.inject({ method: 'GET', url: '/readyz' });
    const requestLines = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry['message'] === 'request');
    expect(requestLines).toHaveLength(0);
  });
});
