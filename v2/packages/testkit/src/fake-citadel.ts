/**
 * A fake Citadel v1 API for integration tests.
 *
 * The fake serves the raw bytes of committed fixtures over real HTTP on an
 * ephemeral port, so the production client can be driven end to end - real
 * `fetch`, real status codes, real sockets - without a live Citadel
 * instance. Fixture bytes are never re-serialised: Citadel sends Discord
 * snowflakes and Steam ids as JSON integers above `Number.MAX_SAFE_INTEGER`,
 * and a re-serialised fixture would round them.
 *
 * `setMode` switches the answer for every later request, which is how the
 * failure paths (401, 404, 5xx, malformed body, a hung response) are reached.
 */
import { createServer, type ServerResponse } from 'node:http';

/** How the fake answers a request. */
export type FakeCitadelMode = 'ok' | '401' | '404' | '500' | '503' | 'malformed' | 'slow';

/** Options accepted by {@link createFakeCitadel}. */
export interface FakeCitadelOptions {
  /**
   * Route path to response body, e.g. `{ 'leagues/9100': '{"league":{}}' }`.
   * The body is served byte for byte.
   */
  fixtures: Record<string, string>;
  /** The mode every request starts in; defaults to `ok`. */
  mode?: FakeCitadelMode;
}

/** A running fake Citadel instance. */
export interface FakeCitadel {
  /** Base URL of the fake, e.g. `http://127.0.0.1:41234`. */
  readonly baseUrl: string;
  /** Answers every later request in the given mode. */
  setMode(mode: FakeCitadelMode): void;
  /** Stops the server and releases the port. */
  close(): Promise<void>;
}

/** The Citadel error bodies the failure modes answer with. */
const ERROR_RESPONSES = {
  '401': { status: 401, body: '{"message":"Invalid API key","status":401}' },
  '404': { status: 404, body: '{"message":"Record not found","status":404}' },
  '500': { status: 500, body: '{"message":"Internal server error","status":500}' },
  '503': { status: 503, body: '{"message":"Service unavailable","status":503}' },
} as const;

/** A 200 answer whose body is not JSON at all. */
const MALFORMED_BODY = '<html>not a citadel body</html>';

/** Strips the query and the surrounding slashes from a request path. */
function routePath(url: string | undefined): string {
  const raw = (url ?? '/').split('?')[0] ?? '/';
  let path = raw;
  try {
    path = decodeURIComponent(raw);
  } catch {
    // A broken escape stays as it arrived; it simply matches no fixture.
  }
  return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Starts a fake Citadel API on an ephemeral port. */
export async function createFakeCitadel(options: FakeCitadelOptions): Promise<FakeCitadel> {
  const fixtures = new Map<string, string>();
  for (const [route, body] of Object.entries(options.fixtures)) {
    fixtures.set(routePath(route), body);
  }
  let mode: FakeCitadelMode = options.mode ?? 'ok';
  // Responses that were opened but never ended; `slow` holds them until the
  // peer aborts or `close()` destroys them.
  const held = new Set<ServerResponse>();

  const server = createServer((request, response) => {
    const headers = { 'content-type': 'application/json', connection: 'close' };

    if (request.method !== 'GET') {
      response.writeHead(405, headers);
      response.end('{"message":"Method not allowed","status":405}');
      return;
    }

    const current: FakeCitadelMode = mode;
    if (current === 'malformed') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
      response.end(MALFORMED_BODY);
      return;
    }
    if (current === 'slow') {
      // The header goes out, the body never does. The peer sees a 200 with a
      // JSON content type and then waits forever for a body that never
      // arrives, which is what the client's timeout guard is there for.
      response.writeHead(200, headers);
      response.flushHeaders();
      held.add(response);
      response.on('error', () => {
        // The peer aborting the held response is its expected end.
      });
      response.on('close', () => {
        held.delete(response);
      });
      return;
    }
    if (current !== 'ok') {
      const failure = ERROR_RESPONSES[current];
      response.writeHead(failure.status, headers);
      response.end(failure.body);
      return;
    }

    const fixture = fixtures.get(routePath(request.url));
    if (fixture === undefined) {
      response.writeHead(404, headers);
      response.end(ERROR_RESPONSES['404'].body);
      return;
    }
    response.writeHead(200, headers);
    response.end(fixture);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    setMode: (next) => {
      mode = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // A held `slow` response never ends on its own, so it is destroyed
        // here; the socket it sits on goes with it.
        for (const response of held) {
          response.destroy();
        }
        held.clear();
        // Undici keeps the connection alive; the port is only free once the
        // sockets are gone.
        server.closeAllConnections();
      }),
  };
}
