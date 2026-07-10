import { pool } from "./db.js";
import { extract } from "./extract.js";

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

  const extracted = await step(leadId, "extract", async () => {
    const result = extract(lead.raw_text, {
      referenceDate: lead.received_at,
      contactHint: lead.contact_hint,
    });
    return { result, detail: `service=${result.service}` };
  });

  await pool.query(
    `UPDATE leads
        SET extracted = $2, status = 'done', completed_at = now()
      WHERE id = $1`,
    [leadId, JSON.stringify(extracted)],
  );
}
