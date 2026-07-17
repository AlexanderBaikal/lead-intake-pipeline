import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "../src/config.js";

/**
 * Configuration is the one input nobody tests and everybody mistypes. These
 * pin the failures that used to be silent: a misspelled provider that quietly
 * downgraded every extraction, and a model with no published price that only
 * blew up once a worker had already claimed a job.
 */

const anthropic = { LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test" };

test("an unset environment yields the documented defaults", () => {
  const config = loadConfig({});
  assert.equal(config.port, 3210);
  assert.equal(config.llmProvider, "mock");
  assert.equal(config.budgetCeilingUsd, 5);
  assert.equal(config.crmRateLimitPerMin, 60);
  assert.equal(config.businessTimeZone, "America/Panama");
  assert.equal(config.crmWebhookUrl, null);
});

test("a misspelled provider is rejected instead of falling back to mock", () => {
  // This is the bug the zod schema exists for: the old cast let `antropic`
  // through, ran the offline parser on every lead, and looked perfectly
  // healthy while doing it.
  assert.throws(() => loadConfig({ LLM_PROVIDER: "antropic" }), /LLM_PROVIDER/);
});

test("a live provider without a priced model fails at boot, not mid-job", () => {
  assert.throws(
    () => loadConfig({ ...anthropic, LLM_MODEL: "claude-not-a-real-model" }),
    /no published price/,
  );
  assert.doesNotThrow(() => loadConfig({ ...anthropic, LLM_MODEL: "claude-haiku-4-5" }));
});

test("a live provider without an API key fails at boot", () => {
  // Otherwise the first worker to claim a job burns all five attempts and
  // leaves a dead lead behind to explain it.
  assert.throws(() => loadConfig({ LLM_PROVIDER: "anthropic" }), /ANTHROPIC_API_KEY/);
});

test("the mock provider needs neither a key nor a priced model", () => {
  assert.doesNotThrow(() => loadConfig({ LLM_MODEL: "something-unpriced" }));
});

test("nonsense numbers and time zones are rejected with the variable named", () => {
  assert.throws(() => loadConfig({ PORT: "not-a-port" }), /PORT/);
  assert.throws(() => loadConfig({ PORT: "70000" }), /PORT/);
  assert.throws(() => loadConfig({ BUDGET_CEILING_USD: "-1" }), /BUDGET_CEILING_USD/);
  assert.throws(
    () => loadConfig({ CRM_RATE_LIMIT_PER_MIN: "0" }),
    /CRM_RATE_LIMIT_PER_MIN/,
  );
  assert.throws(() => loadConfig({ BUSINESS_TZ: "Mars/Olympus_Mons" }), /BUSINESS_TZ/);
  assert.throws(() => loadConfig({ CRM_WEBHOOK_URL: "not-a-url" }), /CRM_WEBHOOK_URL/);
});
