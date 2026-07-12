import { recordCall } from "./budget.js";
import { pool } from "./db.js";
import { getProvider } from "./llm/index.js";
import { microToUsd } from "./pricing.js";

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

export async function processLead(leadId: number): Promise<void> {
  const { rows } = await pool.query<{
    raw_text: string;
    contact_hint: string | null;
    received_at: Date;
  }>(`SELECT raw_text, contact_hint, received_at FROM leads WHERE id = $1`, [leadId]);
  const lead = rows[0];
  if (!lead) throw new Error(`lead ${leadId} vanished before processing`);

  await pool.query(`UPDATE leads SET status = 'processing' WHERE id = $1`, [leadId]);

  const { extracted, source } = await step(leadId, "extract", async () => {
    const outcome = await getProvider().extract({
      text: lead.raw_text,
      contactHint: lead.contact_hint,
      referenceDate: lead.received_at,
    });

    let detail = `${outcome.source} · ${outcome.inputTokens} in / ${outcome.outputTokens} out`;
    if (outcome.model) {
      const cost = await recordCall({
        leadId,
        model: outcome.model,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
      });
      detail += ` · $${microToUsd(cost).toFixed(6)}`;
    }

    return { result: { extracted: outcome.lead, source: outcome.source }, detail };
  });

  await pool.query(
    `UPDATE leads
        SET extracted = $2, extraction_source = $3, status = 'done', completed_at = now()
      WHERE id = $1`,
    [leadId, JSON.stringify(extracted), source],
  );
}
