import { pool } from "./db.js";

export interface Job {
  id: number;
  lead_id: number;
}

export async function enqueue(leadId: number): Promise<void> {
  await pool.query(`INSERT INTO jobs (lead_id) VALUES ($1)`, [leadId]);
}

export async function claimJob(): Promise<Job | null> {
  const { rows } = await pool.query<Job>(
    `SELECT id, lead_id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1`,
  );
  const job = rows[0];
  if (!job) return null;

  await pool.query(`UPDATE jobs SET status = 'running' WHERE id = $1`, [job.id]);
  return job;
}

export async function completeJob(jobId: number): Promise<void> {
  await pool.query(`UPDATE jobs SET status = 'done' WHERE id = $1`, [jobId]);
}

export async function failJob(jobId: number): Promise<void> {
  await pool.query(`UPDATE jobs SET status = 'failed' WHERE id = $1`, [jobId]);
}
