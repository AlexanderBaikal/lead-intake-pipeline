import { config } from "./config.js";
import { pool } from "./db.js";
import { TokenBucket } from "./ratelimit.js";

/**
 * Burst allowance is a tenth of the minute's budget: enough that a handful of
 * leads finishing together go straight out, small enough that an idle hour
 * cannot save up a minute's worth of writes and dump them all at once.
 */
const crmBucket = new TokenBucket(
  Math.max(1, Math.floor(config.crmRateLimitPerMin / 6)),
  config.crmRateLimitPerMin / 60,
);

async function post(url: string, payload: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}`);
  }
}

/** Writes the structured lead to the CRM, paced by the token bucket. */
export async function deliverToCrm(leadId: number, payload: unknown): Promise<string> {
  if (config.crmWebhookUrl) {
    await crmBucket.take();
    await post(config.crmWebhookUrl, payload);
  }

  await pool.query(
    `INSERT INTO deliveries (lead_id, sink, payload) VALUES ($1, $2, $3)`,
    [leadId, "crm", JSON.stringify(payload)],
  );

  return config.crmWebhookUrl
    ? `posted to ${new URL(config.crmWebhookUrl).host}`
    : "recorded in local deliveries table";
}
