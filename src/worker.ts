import { pool } from "./db.js";
import { log } from "./logger.js";
import { processLead } from "./pipeline.js";
import { claimJob, completeJob, failJob, reclaimStale } from "./queue.js";

const IDLE_SLEEP_MS = 500;
const RECLAIM_EVERY_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info("draining, will exit after the current job");
    running = false;
  });
}

let lastReclaim = 0;

log.info("worker started");

while (running) {
  if (Date.now() - lastReclaim > RECLAIM_EVERY_MS) {
    lastReclaim = Date.now();
    const reclaimed = await reclaimStale();
    if (reclaimed > 0) log.warn("reclaimed stale jobs", { count: reclaimed });
  }

  const job = await claimJob();
  if (!job) {
    await sleep(IDLE_SLEEP_MS);
    continue;
  }

  const started = Date.now();
  try {
    await processLead(job.lead_id);
    await completeJob(job.id);
    log.info("lead processed", {
      leadId: job.lead_id,
      attempt: job.attempts,
      ms: Date.now() - started,
    });
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
log.info("worker stopped");
