import assert from "node:assert/strict";
import { test } from "node:test";

import { OllamaProvider } from "../src/llm/ollama.js";

/**
 * The adapter is exercised against a stub `fetch`, so these run with no Ollama
 * on the machine and no model pulled. What is being pinned is the contract the
 * server sees and, more importantly, which failures degrade to the parser and
 * which ones are allowed to fail the job.
 */

const REQUEST = {
  text: "Hola, necesito lavado para 2 carros mañana, mi numero es 6123-4455",
  contactHint: null,
  referenceDate: new Date("2026-03-12T15:00:00Z"),
};

const VALID = {
  customer_name: null,
  contact: "6123-4455",
  service: "wash",
  vehicle_count: 2,
  vehicle_types: [],
  requested_date: "2026-03-13",
  urgency: "today",
  language: "es",
  notes: "",
};

/** Records what reached the server and replies with whatever the test needs. */
function stubFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const impl = (async (url: string | URL, options: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(options.body)) });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("hands the server the schema the CRM record is validated against", async () => {
  const { impl, calls } = stubFetch({ response: JSON.stringify(VALID) });
  await new OllamaProvider(impl).extract(REQUEST);

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.ok(call);
  const sent = call.body;
  const format = sent.format as Record<string, unknown>;

  // The point of generating it from zod: these move together or not at all.
  assert.deepEqual(Object.keys(format.properties as object).sort(), [
    "contact",
    "customer_name",
    "language",
    "notes",
    "requested_date",
    "service",
    "urgency",
    "vehicle_count",
    "vehicle_types",
  ]);
  assert.equal(sent.stream, false);
  // A local model that paraphrases differently on each run makes the evals
  // meaningless as a regression harness.
  assert.equal((sent.options as { temperature: number }).temperature, 0);
});

test("sends the business calendar day, not the UTC one", async () => {
  const { impl, calls } = stubFetch({ response: JSON.stringify(VALID) });
  await new OllamaProvider(impl).extract(REQUEST);

  // 15:00 UTC on the 12th is still the 12th in America/Panama (UTC-5); the
  // model cannot resolve "mañana" without being told which day it is.
  const [call] = calls;
  assert.ok(call);
  assert.match(
    String(call.body.prompt),
    /Reference date \(today, America\/Panama\): 2026-03-12/,
  );
});

test("a well-formed answer is reported as the model's own work", async () => {
  const { impl } = stubFetch({
    response: JSON.stringify(VALID),
    prompt_eval_count: 180,
    eval_count: 64,
  });
  const result = await new OllamaProvider(impl).extract(REQUEST);

  assert.equal(result.source, "model");
  assert.equal(result.lead.vehicle_count, 2);
  assert.equal(result.lead.requested_date, "2026-03-13");
  // Reported even though nothing prices them — a zero here would read as "no
  // model ran".
  assert.equal(result.inputTokens, 180);
  assert.equal(result.outputTokens, 64);
});

test("names the model even though the call is free", async () => {
  const { impl } = stubFetch({ response: JSON.stringify(VALID) });
  const provider = new OllamaProvider(impl);
  const result = await provider.extract(REQUEST);

  // The pipeline bills on `metered`; `model` is what the operator gets told.
  // Conflating the two is what made a local extraction print "parsed locally".
  assert.equal(provider.metered, false);
  assert.equal(typeof provider.model, "string");
  assert.equal(result.model, provider.model);
});

test("an answer the grammar let through but the schema rejects falls back", async () => {
  // Ollama constrains the shape, not the contents: `pattern` and the integer
  // bounds are ours to enforce. A date like this is exactly the invented
  // appointment the whole schema exists to prevent.
  const { impl } = stubFetch({
    response: JSON.stringify({ ...VALID, requested_date: "next friday" }),
  });
  const provider = new OllamaProvider(impl);
  const result = await provider.extract(REQUEST);

  assert.equal(result.source, "heuristic");
  // Still named: the call happened and the operator should be told which model
  // produced something unusable.
  assert.equal(result.model, provider.model);
  // The lead still moves; it just moves with a parser behind it.
  assert.equal(result.lead.vehicle_count, 2);
});

test("prose instead of JSON falls back rather than throwing", async () => {
  const { impl } = stubFetch({ response: "Sure! Here is the lead you asked for." });
  const result = await new OllamaProvider(impl).extract(REQUEST);
  assert.equal(result.source, "heuristic");
});

test("reasoning blocks are stripped before parsing", async () => {
  const { impl } = stubFetch({
    response: `<think>The user wrote in Spanish, so language is es.</think>\n${JSON.stringify(VALID)}`,
  });
  const result = await new OllamaProvider(impl).extract(REQUEST);

  // Without the strip this is a parse error and a perfectly good extraction
  // gets thrown away for a regex parser.
  assert.equal(result.source, "model");
  assert.equal(result.lead.language, "es");
});

test("a server that is down fails the job instead of quietly degrading", async () => {
  const { impl } = stubFetch("upstream is on fire", 500);
  await assert.rejects(
    () => new OllamaProvider(impl).extract(REQUEST),
    /ollama HTTP 500/,
    "an outage tagged as `heuristic` is a pipeline that looks healthy while doing nothing",
  );
});

test("an error carried in a 200 body is still an error", async () => {
  // Ollama reports an unpulled model this way rather than with a status code.
  const { impl } = stubFetch({ error: 'model "gemma3:12b-it-qat" not found' });
  await assert.rejects(() => new OllamaProvider(impl).extract(REQUEST), /not found/);
});

test("a wedged server gives up instead of holding the worker forever", async () => {
  const hang = (async (_url: string, options: RequestInit) =>
    new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    })) as unknown as typeof fetch;

  await assert.rejects(() => new OllamaProvider(hang, 20).extract(REQUEST), /abort/i);
});
