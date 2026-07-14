import { config } from "./config.js";
import { pool } from "./db.js";
import { costMicroUsd, usdToMicro } from "./pricing.js";

export interface BudgetState {
  spentMicroUsd: number;
  ceilingMicroUsd: number;
  remainingMicroUsd: number;
}

/** Rolling 24h spend, summed from the ledger rather than tracked in memory. */
export async function currentSpend(): Promise<BudgetState> {
  const { rows } = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(cost_micro_usd), 0)::text AS total
       FROM llm_calls
      WHERE created_at > now() - interval '24 hours'`,
  );
  const spentMicroUsd = Number(rows[0]?.total ?? "0");
  const ceilingMicroUsd = usdToMicro(config.budgetCeilingUsd);
  return {
    spentMicroUsd,
    ceilingMicroUsd,
    remainingMicroUsd: Math.max(0, ceilingMicroUsd - spentMicroUsd),
  };
}

/**
 * Gate a call *before* it happens, using the counted input tokens plus the
 * worst case output (max_tokens). Checking afterwards would only tell us how
 * far over we already are.
 */
export async function canAfford(
  model: string,
  estimatedInputTokens: number,
  maxOutputTokens: number,
): Promise<{ allowed: boolean; state: BudgetState; worstCaseMicroUsd: number }> {
  const state = await currentSpend();
  const worstCaseMicroUsd = costMicroUsd(model, estimatedInputTokens, maxOutputTokens);
  return {
    allowed: worstCaseMicroUsd <= state.remainingMicroUsd,
    state,
    worstCaseMicroUsd,
  };
}

export async function recordCall(params: {
  leadId: number | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<number> {
  const cost = costMicroUsd(params.model, params.inputTokens, params.outputTokens);
  await pool.query(
    `INSERT INTO llm_calls (lead_id, model, input_tokens, output_tokens, cost_micro_usd)
     VALUES ($1, $2, $3, $4, $5)`,
    [params.leadId, params.model, params.inputTokens, params.outputTokens, cost],
  );
  return cost;
}
