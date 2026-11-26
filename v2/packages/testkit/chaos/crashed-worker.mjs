/**
 * The SIGKILL chaos child for the failure-injection suite (plan 05 §3.1
 * level L6, scenario 2 of §3.4).
 *
 * This is deliberately not workspace code: it is a self-contained Node
 * process that talks to the test database over `pg` only, so the suite can
 * kill it with a real SIGKILL while it holds a running job — something an
 * in-process fake cannot make true. It performs exactly what a worker does
 * around the crash window the scenario probes: takes over an expired lease
 * with the journal row a reclaim writes, marks the step it is about to
 * execute as running, then heartbeats the lease and parks mid-step until
 * it is killed. No workspace import and no build output is involved, so the
 * suite runs straight from a clean checkout.
 *
 * Input arrives entirely through the environment:
 *   DRB_DB_URL     test database URL
 *   DRB_JOB_ID     the running job whose expired lease it takes over
 *   DRB_STEP_SEQ   the step it marks running (mid-execution)
 *   DRB_READY_FILE written once the step is mid-execution; the parent kills after it
 *
 * Exit codes: 2 bad input, 3 the takeover lost the row (so a mis-wired
 * scenario fails loudly instead of hanging), 1 a database error.
 */
import { writeFileSync } from 'node:fs';
import pg from 'pg';

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`crashed-worker: ${name} is required\n`);
    process.exit(2);
  }
  return value;
};

const url = required('DRB_DB_URL');
const jobId = required('DRB_JOB_ID');
const stepSeq = Number(required('DRB_STEP_SEQ'));
const readyFile = required('DRB_READY_FILE');
const owner = `chaos-${process.pid}`;

const pool = new pg.Pool({ connectionString: url, max: 1 });

try {
  const before = await pool.query('select lease_owner from jobs where id = $1', [jobId]);
  const previousOwner = before.rows[0]?.lease_owner ?? null;
  const takeover = await pool.query(
    "update jobs set lease_owner = $2, lease_expires_at = now() + interval '60 seconds', " +
      'attempt = attempt + 1, updated_at = now() ' +
      "where id = $1 and state = 'running' and lease_expires_at < now() " +
      'and lease_owner is not distinct from $3 returning id',
    [jobId, owner, previousOwner],
  );
  if (takeover.rowCount !== 1) {
    process.stderr.write(`crashed-worker: lost the takeover of job ${jobId}\n`);
    process.exit(3);
  }

  await pool.query(
    'insert into job_events (job_id, level, code, message, data) values ' +
      "( $1, 'info', 'job.lease.reclaimed', $2, jsonb_build_object('previousOwner', $3::text) )",
    [jobId, `Expired lease reclaimed by ${owner}`, previousOwner],
  );
  await pool.query(
    'update job_steps set status = $3, started_at = now() where job_id = $1 and seq = $2',
    [jobId, stepSeq, 'running'],
  );

  writeFileSync(readyFile, owner);
  process.stdout.write(`READY ${owner}\n`);

  // Mid-step: keep the lease alive the way a live worker would until the
  // parent sends the SIGKILL. The claim lease (60 s) is what the recovery
  // path has to work with; the heartbeat below may never fire before the
  // kill lands, which is exactly the window the scenario drives.
  for (;;) {
    await pool.query(
      "update jobs set lease_expires_at = now() + interval '15 seconds' where id = $1 and lease_owner = $2",
      [jobId, owner],
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 2_000);
    });
  }
} catch (error) {
  process.stderr.write(`crashed-worker: ${String(error)}\n`);
  process.exit(1);
}
