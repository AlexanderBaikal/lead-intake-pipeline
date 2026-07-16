import { pool } from "./db.js";

export interface Job {
  id: number;
  lead_id: number;
  attempts: number;
  max_attempts: number;
}

/**
 * Claim one job atomically.
 *
 * `FOR UPDATE SKIP LOCKED` is what lets N workers share one table without a
 * broker: each transaction locks its row and every other worker steps over it
 * instead of blocking. Without SKIP LOCKED the workers serialize behind the
 * same row and the extra processes buy nothing.
 */
export async function claimJob(): Promise<Job | null> {
  const { rows } = await pool.query<Job>(
    `UPDATE jobs
        SET status = 'running',
            attempts = attempts + 1,
            locked_at = now()
      WHERE id = (
        SELECT id FROM jobs
         WHERE status = 'queued' AND run_after <= now()
         -- id breaks the tie: everything enqueued in the same instant shares a
         -- run_after, and without it the queue is only approximately FIFO.
         ORDER BY run_after, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING id, lead_id, attempts, max_attempts`,
  );
  return rows[0] ?? null;
}

export async function enqueue(leadId: number): Promise<void> {
  await pool.query(`INSERT INTO jobs (lead_id) VALUES ($1)`, [leadId]);
}

export async function completeJob(jobId: number): Promise<void> {
  await pool.query(`UPDATE jobs SET status = 'done', locked_at = NULL WHERE id = $1`, [
    jobId,
  ]);
}

/** Exponential backoff, capped — 2s, 4s, 8s, 16s, then dead. */
export async function failJob(job: Job, error: unknown): Promise<"retry" | "dead"> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.max_attempts;
  const delaySeconds = Math.min(2 ** job.attempts, 300);

  await pool.query(
    `UPDATE jobs
        SET status = $2,
            last_error = $3,
            locked_at = NULL,
            run_after = now() + make_interval(secs => $4)
      WHERE id = $1`,
    [job.id, exhausted ? "dead" : "queued", message.slice(0, 2_000), delaySeconds],
  );

  if (exhausted) {
    await pool.query(`UPDATE leads SET status = 'failed' WHERE id = $1`, [job.lead_id]);
  }
  return exhausted ? "dead" : "retry";
}

/**
 * Return jobs whose worker died mid-run to the queue. A crashed process leaves
 * `running` rows nobody will ever finish, and without this they are invisible
 * rather than merely late.
 */
export async function reclaimStale(olderThanSeconds = 120): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE jobs
        SET status = 'queued', locked_at = NULL
      WHERE status = 'running'
        AND locked_at < now() - make_interval(secs => $1)`,
    [olderThanSeconds],
  );
  return rowCount ?? 0;
}
