import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadConfig } from "../src/config.js";
import {
  ExtractedLead,
  IdempotencyKey,
  LeadInput,
  SERVICES,
  URGENCIES,
} from "../src/schema.js";

/**
 * The drift check that makes openapi.yaml a contract instead of a description.
 *
 * The published document and the schema the server actually validates against
 * are written in two places, so they can disagree — and a spec that quietly
 * disagrees with the code is worse than no spec, because integrators trust it.
 * This test fails the build the moment they do.
 */

const here = dirname(fileURLToPath(import.meta.url));
const spec = readFileSync(join(here, "..", "openapi.yaml"), "utf8");

/** Reads `key:\n  type: string\n  enum: [a, b, c]` — the shape used in the doc. */
function specEnum(key: string): string[] {
  const match = new RegExp(
    `^\\s*${key}:\\s*\\n\\s*type: string\\s*\\n\\s*enum: \\[([^\\]]*)\\]`,
    "m",
  ).exec(spec);
  assert.ok(match?.[1], `openapi.yaml has no enum block for "${key}"`);
  return match[1]
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
}

function specRequired(schemaName: string): string[] {
  const start = spec.indexOf(`${schemaName}:`);
  assert.ok(start > -1, `openapi.yaml has no schema named "${schemaName}"`);
  const match = /required:\s*\n?\s*\[([^\]]*)\]/.exec(spec.slice(start));
  assert.ok(match?.[1], `"${schemaName}" has no required list`);
  return match[1]
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
}

test("LeadInput channel enum matches the server's validator", () => {
  const zodChannels = [...LeadInput.shape.channel.options].sort();
  assert.deepEqual(specEnum("channel"), zodChannels);
});

test("service and urgency enums match the extraction schema", () => {
  assert.deepEqual(specEnum("service"), [...SERVICES].sort());
  assert.deepEqual(specEnum("urgency"), [...URGENCIES].sort());
});

test("ExtractedLead exposes exactly the documented fields", () => {
  const zodFields = Object.keys(ExtractedLead.shape).sort();
  assert.deepEqual(specRequired("ExtractedLead"), zodFields);
});

test("the documented base URL points at the port the server binds", () => {
  const documented = /url: http:\/\/localhost:(\d+)/.exec(spec);
  assert.ok(documented?.[1], "openapi.yaml lost its server URL");
  // A spec whose very first field sends integrators to the wrong port is the
  // cheapest possible way to lose the trust the rest of it is asking for.
  assert.equal(Number(documented[1]), loadConfig({}).port);
});

test("the documented Idempotency-Key bounds match the validator", () => {
  const documented =
    /name: Idempotency-Key[\s\S]*?minLength: (\d+), maxLength: (\d+)/.exec(spec);
  assert.ok(documented, "openapi.yaml lost the Idempotency-Key bounds");
  const [min, max] = [Number(documented[1]), Number(documented[2])];

  assert.equal(IdempotencyKey.safeParse("x".repeat(min)).success, true);
  assert.equal(IdempotencyKey.safeParse("x".repeat(min - 1)).success, false);
  assert.equal(IdempotencyKey.safeParse("x".repeat(max)).success, true);
  assert.equal(IdempotencyKey.safeParse("x".repeat(max + 1)).success, false);
  // The empty header that used to pass as a key and collapse every request
  // carrying one onto a single lead.
  assert.equal(IdempotencyKey.safeParse("").success, false);
});

test("the documented text limit matches the one the server enforces", () => {
  const documented = /maxLength: (\d+)\s*\n\s*description: Whatever the customer/.exec(
    spec,
  );
  assert.ok(documented?.[1], "openapi.yaml lost the text maxLength");
  // A doc promising 8000 chars while the server rejects at 4000 sends
  // integrators a 400 they cannot explain from the spec.
  assert.equal(
    LeadInput.safeParse({
      channel: "web_form",
      text: "x".repeat(Number(documented[1])),
    }).success,
    true,
  );
  assert.equal(
    LeadInput.safeParse({
      channel: "web_form",
      text: "x".repeat(Number(documented[1]) + 1),
    }).success,
    false,
  );
});
