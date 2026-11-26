/**
 * Per-league job realtime (plan 02 §5.3, §11).
 *
 * Every job state transition commits through the `jobs` table, and a
 * Postgres trigger (migration `0004`) notifies one channel per league with
 * the transition as a JSON payload. `listenJobState` holds a dedicated
 * connection out of the pool on that channel and hands every payload to
 * the caller the moment Postgres delivers it - notifications are released
 * at commit, so a listener sees a transition within milliseconds of it
 * being durable. Nothing is buffered here: each payload is delivered once,
 * as it arrives, and closing the listener returns the connection.
 */
import type { Pool } from 'pg';

/** The channel one league's job notifications arrive on (02 §11). */
export function jobStateChannel(leagueId: string): string {
  return `drawbridge_jobs_${leagueId}`;
}

export interface JobStateListenOptions {
  /** Receives each notification payload as it arrives, unparsed. */
  onPayload: (payload: string) => void;
  /**
   * The listener connection died. The handle must be closed; Postgres
   * delivers nothing on a dead connection, so holding it would silence
   * the stream instead of ending it.
   */
  onError: (error: unknown) => void;
}

/** A live LISTEN on one league's channel; `close` returns the connection. */
export interface JobStateListener {
  close(): Promise<void>;
}

/**
 * Listens on one league's job channel until closed.
 *
 * The listener owns a dedicated pool connection: `LISTEN` is per-connection
 * state, so a connection may not be shared between streams that listen for
 * different leagues - each stream hears exactly its own league and nothing
 * else.
 */
export async function listenJobState(
  pool: Pool,
  leagueId: string,
  options: JobStateListenOptions,
): Promise<JobStateListener> {
  const channel = jobStateChannel(leagueId);
  const client = await pool.connect();
  let closed = false;

  const onNotification = (message: {
    channel?: string | undefined;
    payload?: string | undefined;
  }): void => {
    if (message.channel !== channel) return;
    if (typeof message.payload !== 'string') return;
    options.onPayload(message.payload);
  };
  client.on('notification', onNotification);
  // A checked-out client that errors would raise an unhandled 'error' event
  // (crashing the process) if nobody listened; forward it to the caller.
  const onError = (error: unknown): void => {
    if (!closed) options.onError(error);
  };
  client.on('error', onError);

  try {
    await client.query(`listen "${channel}"`);
  } catch (error) {
    client.removeListener('notification', onNotification);
    client.removeListener('error', onError);
    client.release(error as Error);
    throw error;
  }

  return {
    close: async () => {
      if (closed) return;
      closed = true;
      client.removeListener('notification', onNotification);
      client.removeListener('error', onError);
      try {
        // UNLISTEN * (not just the one channel): the connection returns to
        // the pool and must not carry listener state into its next job.
        await client.query('unlisten *');
        client.release();
      } catch (error) {
        // The connection is unusable; discard it instead of returning a
        // listener to the pool.
        client.release(error as Error);
      }
    },
  };
}

export type { Pool };
