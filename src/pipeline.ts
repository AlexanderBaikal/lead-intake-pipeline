import { canAfford, recordCall } from "./budget.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { heuristicExtract } from "./llm/heuristic.js";
import { getProvider } from "./llm/index.js";
import { log } from "./logger.js";
import { microToUsd } from "./pricing.js";
import type { ExtractedLead } from "./schema.js";
import { deliverToCrm, notify } from "./sinks.js";

interface LeadRow {
  id: number;
  channel: string;
  raw_text: string;
  contact_hint: string | null;
  received_at: Date;
}

async function step<T>(
  leadId: number,
  name: string,
  fn: () => Promise<{ result: T; detail: string }>,
): Promise<T> {
  const started = Date.now();
  try {
    const { result, detail } = await fn();
    await pool.query(
      `INSERT INTO steps (lead_id, name, ok, detail, ms) VALUES ($1, $2, true, $3, $4)`,
      [leadId, name, detail, Date.now() - started],
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(
      `INSERT INTO steps (lead_id, name, ok, detail, ms) VALUES ($1, $2, false, $3, $4)`,
      [leadId, name, message.slice(0, 1_000), Date.now() - started],
    );
    throw error;
  }
}

interface Extraction {
  extracted: ExtractedLead;
  source: string;
  detail: string;
}

async function extract(lead: LeadRow): Promise<Extraction> {
  const provider = getProvider();
  const request = {
    text: lead.raw_text,
    contactHint: lead.contact_hint,
    referenceDate: lead.received_at,
  };

  if (provider.metered) {
    const estimatedInput = await provider.estimateInputTokens(request);
    const budget = await canAfford(
      config.llmModel,
      estimatedInput,
      provider.maxOutputTokens,
    );

    // Over budget is a business state, not an outage: degrade to the parser and
    // keep the lead moving rather than stalling the queue until midnight.
    if (!budget.allowed) {
      const spent = microToUsd(budget.state.spentMicroUsd);
      const ceiling = microToUsd(budget.state.ceilingMicroUsd);
      log.warn("budget ceiling reached, using deterministic parser", {
        leadId: lead.id,
        spentUsd: spent,
        ceilingUsd: ceiling,
      });
      return {
        extracted: heuristicExtract(lead.raw_text, {
          referenceDate: lead.received_at,
          contactHint: lead.contact_hint,
        }),
        source: "heuristic",
        detail: `budget ceiling reached ($${spent.toFixed(4)} of $${ceiling.toFixed(2)} in 24h) — parsed locally`,
      };
    }
  }

  const result = await provider.extract(request);

  // Billing keys off `metered`, not off whether a model ran. A local model
  // names itself and still costs nothing; reading `model` as "this was
  // billable" would either bill it against a price that does not exist or
  // report a real extraction to the operator as "parsed locally".
  if (!provider.metered) {
    return {
      extracted: result.lead,
      source: result.source,
      detail: result.model
        ? `${result.source} · ${result.model} · no cost`
        : "parsed locally",
    };
  }

  // A metered provider that reports no model leaves the ledger with nothing to
  // record, which is how a call becomes free by accident. Same reasoning as the
  // unpriced-model throw in src/pricing.ts.
  if (!result.model) {
    throw new Error(`metered provider "${provider.name}" returned no model to bill`);
  }

  const cost = await recordCall({
    leadId: lead.id,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  });

  return {
    extracted: result.lead,
    source: result.source,
    detail: `${result.source} · ${result.inputTokens} in / ${result.outputTokens} out · $${microToUsd(cost).toFixed(6)}`,
  };
}

export async function processLead(leadId: number): Promise<void> {
  const { rows } = await pool.query<LeadRow>(
    `SELECT id, channel, raw_text, contact_hint, received_at FROM leads WHERE id = $1`,
    [leadId],
  );
  const lead = rows[0];
  if (!lead) throw new Error(`lead ${leadId} vanished before processing`);

  await pool.query(`UPDATE leads SET status = 'processing' WHERE id = $1`, [leadId]);

  const { extracted, source } = await step(leadId, "extract", async () => {
    const outcome = await extract(lead);
    return { result: outcome, detail: outcome.detail };
  });

  await pool.query(
    `UPDATE leads SET extracted = $2, extraction_source = $3 WHERE id = $1`,
    [leadId, JSON.stringify(extracted), source],
  );

  const crmPayload = { lead_id: leadId, channel: lead.channel, ...extracted };
  await step(leadId, "deliver_crm", async () => ({
    result: null,
    detail: await deliverToCrm(leadId, crmPayload),
  }));

  await step(leadId, "notify", async () => ({
    result: null,
    detail: await notify(leadId, {
      lead_id: leadId,
      summary: `${extracted.service} · ${extracted.vehicle_count} vehicle(s) · ${extracted.urgency}`,
      customer: extracted.customer_name ?? extracted.contact ?? "unknown",
    }),
  }));

  await pool.query(
    `UPDATE leads SET status = 'done', completed_at = now() WHERE id = $1`,
    [leadId],
  );
}
