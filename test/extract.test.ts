import assert from "node:assert/strict";
import { test } from "node:test";

import { extract } from "../src/extract.js";
import { ExtractedLead } from "../src/schema.js";

const REF = new Date("2026-04-11T12:00:00Z"); // a Saturday

test("output always satisfies the schema, even for junk input", () => {
  for (const text of ["", "?????", "aaaaaaaa", "🚗🚗🚗", "1"]) {
    const result = extract(text || " ", { referenceDate: REF });
    assert.doesNotThrow(
      () => ExtractedLead.parse(result),
      `failed on ${JSON.stringify(text)}`,
    );
  }
});

test("resolves relative dates against the reference, not the wall clock", () => {
  assert.equal(
    extract("lavado mañana", { referenceDate: REF }).requested_date,
    "2026-04-12",
  );
  assert.equal(
    extract("wash today", { referenceDate: REF }).requested_date,
    "2026-04-11",
  );
});

test("never invents a date the message does not contain", () => {
  assert.equal(
    extract("cuanto cuesta un lavado?", { referenceDate: REF }).requested_date,
    null,
  );
});

test("counts vehicles from digits and from words", () => {
  assert.equal(extract("3 camionetas", { referenceDate: REF }).vehicle_count, 3);
  assert.equal(extract("cinco vehiculos", { referenceDate: REF }).vehicle_count, 5);
  assert.equal(extract("necesito lavado", { referenceDate: REF }).vehicle_count, 1);
});

test("falls back to the channel-supplied contact only when the text has none", () => {
  const fromText = extract("escribeme a a@b.com", {
    referenceDate: REF,
    contactHint: "+50761234567",
  });
  assert.equal(fromText.contact, "a@b.com");

  const fromHint = extract("quiero lavado", {
    referenceDate: REF,
    contactHint: "+50761234567",
  });
  assert.equal(fromHint.contact, "+50761234567");
});
