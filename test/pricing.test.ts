import assert from "node:assert/strict";
import { test } from "node:test";

import { MODEL_PRICES, costMicroUsd } from "../src/pricing.js";

test("prices a call against the published per-million rate", () => {
  // claude-opus-5 is $5 / $25 per million tokens.
  // 1M in + 1M out = $30 = 30_000_000 micro-dollars.
  assert.equal(costMicroUsd("claude-opus-5", 1_000_000, 1_000_000), 30_000_000);
  assert.equal(costMicroUsd("claude-opus-5", 1_000, 0), 5_000);
  assert.equal(costMicroUsd("claude-opus-5", 0, 1_000), 25_000);
});

test("integer accounting does not drift over many small calls", () => {
  // The same arithmetic in floating-point dollars accumulates error; this is
  // why the ledger stores micro-dollars as integers.
  let total = 0;
  for (let i = 0; i < 100_000; i += 1) total += costMicroUsd("claude-opus-5", 137, 41);
  assert.equal(total, 100_000 * (137 * 5 + 41 * 25));
  assert.ok(Number.isSafeInteger(total));
});

test("an unpriced model throws instead of billing as free", () => {
  // Silently costing zero would make the ceiling unenforceable for exactly
  // the model nobody has priced yet.
  assert.throws(
    () => costMicroUsd("claude-not-a-real-model", 100, 100),
    /no published price/,
  );
});

test("every priced model has positive input and output rates", () => {
  for (const [model, price] of Object.entries(MODEL_PRICES)) {
    assert.ok(price.input > 0, `${model} input price must be positive`);
    assert.ok(price.output > 0, `${model} output price must be positive`);
    assert.ok(
      price.output >= price.input,
      `${model} output should not be cheaper than input`,
    );
  }
});
