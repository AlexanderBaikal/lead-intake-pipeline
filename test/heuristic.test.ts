import assert from "node:assert/strict";
import { test } from "node:test";

import { heuristicExtract } from "../src/llm/heuristic.js";
import { ExtractedLead } from "../src/schema.js";

const REF = new Date("2026-04-11T12:00:00Z"); // a Saturday

test("output always satisfies the schema, even for junk input", () => {
  for (const text of ["", "?????", "aaaaaaaa", "🚗🚗🚗", "1"]) {
    const result = heuristicExtract(text || " ", { referenceDate: REF });
    assert.doesNotThrow(
      () => ExtractedLead.parse(result),
      `failed on ${JSON.stringify(text)}`,
    );
  }
});

test("resolves relative dates against the reference, not the wall clock", () => {
  assert.equal(
    heuristicExtract("lavado mañana", { referenceDate: REF }).requested_date,
    "2026-04-12",
  );
  assert.equal(
    heuristicExtract("wash today", { referenceDate: REF }).requested_date,
    "2026-04-11",
  );
});

test("never invents a date the message does not contain", () => {
  assert.equal(
    heuristicExtract("cuanto cuesta un lavado?", { referenceDate: REF }).requested_date,
    null,
  );
});

test("counts vehicles from digits and from words", () => {
  assert.equal(heuristicExtract("3 camionetas", { referenceDate: REF }).vehicle_count, 3);
  assert.equal(
    heuristicExtract("cinco vehiculos", { referenceDate: REF }).vehicle_count,
    5,
  );
  assert.equal(
    heuristicExtract("necesito lavado", { referenceDate: REF }).vehicle_count,
    1,
  );
});

test("falls back to the channel-supplied contact only when the text has none", () => {
  const fromText = heuristicExtract("escribeme a a@b.com", {
    referenceDate: REF,
    contactHint: "+50761234567",
  });
  assert.equal(fromText.contact, "a@b.com");

  const fromHint = heuristicExtract("quiero lavado", {
    referenceDate: REF,
    contactHint: "+50761234567",
  });
  assert.equal(fromHint.contact, "+50761234567");
});
