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

/**
 * Every delivery is written to `deliveries` whether or not a webhook is
 * configured, so an unconfigured demo still has somewhere real to deliver to
 * and a configured one keeps a record of what it sent.
 */
async function deliver(
  leadId: number,
  sink: string,
  url: string | null,
  payload: unknown,
  bucket?: TokenBucket,
): Promise<string> {
  // Pacing protects the partner's limit, so it applies to the network call and
  // not to the local insert that stands in for it.
  if (url) {
    await bucket?.take();
    await post(url, payload);
  }

  await pool.query(
    `INSERT INTO deliveries (lead_id, sink, payload) VALUES ($1, $2, $3)`,
    [leadId, sink, JSON.stringify(payload)],
  );

  return url ? `posted to ${new URL(url).host}` : "recorded in local deliveries table";
}

/** Writes the structured lead to the CRM, paced by the token bucket. */
export const deliverToCrm = (leadId: number, payload: unknown): Promise<string> =>
  deliver(leadId, "crm", config.crmWebhookUrl, payload, crmBucket);

/** Pings whoever handles the lead. Not rate-limited: one message per lead. */
export const notify = (leadId: number, payload: unknown): Promise<string> =>
  deliver(leadId, "notify", config.notifyWebhookUrl, payload);
