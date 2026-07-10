import { pool } from "./db.js";

export interface Job {
  id: number;
  lead_id: number;
}

export async function enqueue(leadId: number): Promise<void> {
  await pool.query(`INSERT INTO jobs (lead_id) VALUES ($1)`, [leadId]);
}

/**
 * Claim one job atomically. SELECT-then-UPDATE handed the same row to both
 * workers; the UPDATE has to be the thing that picks the row.
 *
 * SKIP LOCKED is what makes the second worker worth starting: without it it
 * blocks on the row the first one holds instead of taking the next one.
 */
export async function claimJob(): Promise<Job | null> {
  const { rows } = await pool.query<Job>(
    `UPDATE jobs
        SET status = 'running'
      WHERE id = (
        SELECT id FROM jobs
         WHERE status = 'queued'
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING id, lead_id`,
  );
  return rows[0] ?? null;
}

export async function completeJob(jobId: number): Promise<void> {
  await pool.query(`UPDATE jobs SET status = 'done' WHERE id = $1`, [jobId]);
}

export async function failJob(jobId: number): Promise<void> {
  await pool.query(`UPDATE jobs SET status = 'failed' WHERE id = $1`, [jobId]);
}
