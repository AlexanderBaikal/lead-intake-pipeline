import { pool } from "./db.js";
import { log } from "./logger.js";
import { processLead } from "./pipeline.js";
import { claimJob, completeJob, failJob } from "./queue.js";

const IDLE_SLEEP_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

log.info("worker started");

for (;;) {
  const job = await claimJob();
  if (!job) {
    await sleep(IDLE_SLEEP_MS);
    continue;
  }

  try {
    await processLead(job.lead_id);
    await completeJob(job.id);
    log.info("lead processed", { leadId: job.lead_id });
  } catch (error) {
    const outcome = await failJob(job, error);
    log.error("lead failed", {
      leadId: job.lead_id,
      attempt: job.attempts,
      outcome,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

await pool.end();
