import { pool } from "./db.js";
import { extract } from "./extract.js";

export async function processLead(leadId: number): Promise<void> {
  const { rows } = await pool.query<{ raw_text: string; received_at: Date }>(
    `SELECT raw_text, received_at FROM leads WHERE id = $1`,
    [leadId],
  );
  const lead = rows[0];
  if (!lead) throw new Error(`lead ${leadId} vanished before processing`);

  const extracted = extract(lead.raw_text, lead.received_at);

  await pool.query(
    `UPDATE leads
        SET extracted = $2, status = 'done', completed_at = now()
      WHERE id = $1`,
    [leadId, JSON.stringify(extracted)],
  );
}
