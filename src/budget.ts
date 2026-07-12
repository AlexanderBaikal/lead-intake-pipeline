import { pool } from "./db.js";

/** Published list prices, USD per million tokens. */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export function costUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = PRICES[model] ?? { input: 0, output: 0 };
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/** Rolling 24h spend, summed from the ledger rather than tracked in memory. */
export async function currentSpendUsd(): Promise<number> {
  const { rows } = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(cost_usd), 0)::text AS total
       FROM llm_calls
      WHERE created_at > now() - interval '24 hours'`,
  );
  return Number(rows[0].total);
}

export async function recordCall(params: {
  leadId: number | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<number> {
  const cost = costUsd(params.model, params.inputTokens, params.outputTokens);
  await pool.query(
    `INSERT INTO llm_calls (lead_id, model, input_tokens, output_tokens, cost_usd)
     VALUES ($1, $2, $3, $4, $5)`,
    [params.leadId, params.model, params.inputTokens, params.outputTokens, cost],
  );
  return cost;
}
