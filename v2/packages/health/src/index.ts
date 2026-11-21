/**
 * Readiness model.
 *
 * A dependency check reports one of:
 *  - `ok`      the dependency answered
 *  - `down`    the dependency is required and did not answer
 *  - `unknown` not wired up yet (never fails readiness by itself, but is
 *              visible in the payload so a missing check is not mistaken for
 *              a healthy dependency)
 */
export type DependencyStatus = 'ok' | 'down' | 'unknown';
export type ReadinessStatus = 'ok' | 'degraded' | 'down';

export interface DependencyResult {
  name: string;
  status: DependencyStatus;
  required: boolean;
  durationMs: number;
  reason?: string;
}

export interface ReadinessReport {
  status: ReadinessStatus;
  dependencies: DependencyResult[];
}

/** A check returns true when the dependency answered, or throws to fail. */
export type DependencyCheck = () => Promise<boolean>;

export interface Dependency {
  name: string;
  required: boolean;
  check: DependencyCheck;
}

export function httpStatusFor(status: ReadinessStatus): 200 | 503 {
  return status === 'down' ? 503 : 200;
}

/**
 * Runs every dependency check concurrently. A check that throws is reported as
 * `down`. A required dependency that is down makes the whole report `down`.
 * Optional dependencies that are down only make it `degraded`.
 */
export async function evaluateReadiness(
  dependencies: readonly Dependency[],
): Promise<ReadinessReport> {
  const results = await Promise.all(
    dependencies.map(async (dependency): Promise<DependencyResult> => {
      const started = performance.now();
      try {
        const ok = await dependency.check();
        return {
          name: dependency.name,
          status: ok ? 'ok' : 'down',
          required: dependency.required,
          durationMs: Math.round(performance.now() - started),
        };
      } catch (error) {
        return {
          name: dependency.name,
          status: 'down',
          required: dependency.required,
          durationMs: Math.round(performance.now() - started),
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  const requiredDown = results.some((result) => result.required && result.status === 'down');
  const anyDown = results.some((result) => result.status === 'down');
  const status: ReadinessStatus = requiredDown ? 'down' : anyDown ? 'degraded' : 'ok';
  return { status, dependencies: results };
}

/** A dependency that is not wired up yet. Reachable in the readiness payload. */
export function notImplemented(name: string, required = true): Dependency {
  return {
    name,
    required,
    check: async () => false,
  };
}
