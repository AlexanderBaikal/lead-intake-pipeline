import { pool } from "./db.js";
import { processLead } from "./pipeline.js";
import { claimJob, completeJob, failJob } from "./queue.js";

const IDLE_SLEEP_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

console.log("worker started");

for (;;) {
  const job = await claimJob();
  if (!job) {
    await sleep(IDLE_SLEEP_MS);
    continue;
  }

  try {
    await processLead(job.lead_id);
    await completeJob(job.id);
    console.log(`lead ${job.lead_id} done`);
  } catch (error) {
    await failJob(job.id);
    console.error(`lead ${job.lead_id} failed`, error);
  }
}

await pool.end();
