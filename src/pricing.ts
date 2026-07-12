/**
 * What a model call costs, in integer micro-dollars.
 *
 * A price per million tokens in dollars is numerically the same as the price
 * per single token in micro-dollars, so cost accounting stays in integers and
 * never accumulates float error across thousands of calls.
 */

const MICRO_PER_USD = 1_000_000;

interface ModelPrice {
  readonly input: number;
  readonly output: number;
}

/** Published list prices, USD per million tokens. */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export const isPriced = (model: string): boolean => model in MODEL_PRICES;

export const microToUsd = (micro: number): number => micro / MICRO_PER_USD;

export const usdToMicro = (usd: number): number => Math.round(usd * MICRO_PER_USD);

export function costMicroUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = MODEL_PRICES[model];
  // An unpriced model must not silently bill as free — that would make the
  // ceiling unenforceable for exactly the model nobody has priced yet.
  if (!price) throw new Error(`no published price for model "${model}"`);
  return Math.round(inputTokens * price.input + outputTokens * price.output);
}
