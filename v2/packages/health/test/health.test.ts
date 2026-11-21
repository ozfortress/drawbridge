import { describe, expect, it } from 'vitest';
import { evaluateReadiness, httpStatusFor, notImplemented } from '../src/index.js';

describe('readiness', () => {
  it('is ok when every dependency answers', async () => {
    const report = await evaluateReadiness([
      { name: 'postgres', required: true, check: async () => true },
      { name: 's3', required: true, check: async () => true },
    ]);
    expect(report.status).toBe('ok');
    expect(httpStatusFor(report.status)).toBe(200);
  });

  it('is down when a required dependency fails', async () => {
    const report = await evaluateReadiness([
      { name: 'postgres', required: true, check: async () => false },
      { name: 's3', required: true, check: async () => true },
    ]);
    expect(report.status).toBe('down');
    expect(httpStatusFor(report.status)).toBe(503);
  });

  it('is degraded when only an optional dependency fails', async () => {
    const report = await evaluateReadiness([
      { name: 'postgres', required: true, check: async () => true },
      { name: 'logs.tf', required: false, check: async () => false },
    ]);
    expect(report.status).toBe('degraded');
    expect(httpStatusFor(report.status)).toBe(200);
  });

  it('reports a throwing dependency as down, with the reason', async () => {
    const report = await evaluateReadiness([
      {
        name: 'postgres',
        required: true,
        check: async () => {
          throw new Error('connection refused');
        },
      },
    ]);
    expect(report.status).toBe('down');
    expect(report.dependencies[0]?.reason).toBe('connection refused');
  });

  it('keeps unimplemented checks visible but not fatal', async () => {
    const report = await evaluateReadiness([notImplemented('discord', false)]);
    expect(report.status).toBe('degraded');
    expect(report.dependencies[0]?.status).toBe('down');
    expect(report.dependencies[0]?.required).toBe(false);
  });

  it('runs checks concurrently and records durations', async () => {
    const started = performance.now();
    const report = await evaluateReadiness([
      {
        name: 'slow-a',
        required: true,
        check: () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 50)),
      },
      {
        name: 'slow-b',
        required: true,
        check: () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 50)),
      },
    ]);
    expect(report.status).toBe('ok');
    expect(performance.now() - started).toBeLessThan(95);
    expect(report.dependencies.every((d) => d.durationMs >= 0)).toBe(true);
  });
});
