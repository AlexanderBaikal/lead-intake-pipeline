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
  assert.equal(
    heuristicExtract("pasado mañana", { referenceDate: REF }).requested_date,
    "2026-04-13",
  );
});

test("a weekday that matches the reference day means next week, not today", () => {
  // REF is a Saturday; "sabado" must resolve seven days out, not to REF itself.
  assert.equal(
    heuristicExtract("nos vemos el sabado", { referenceDate: REF }).requested_date,
    "2026-04-18",
  );
});

test("never invents a date the message does not contain", () => {
  assert.equal(
    heuristicExtract("cuanto cuesta un lavado?", { referenceDate: REF }).requested_date,
    null,
  );
});

test("subscription wins over a wash mentioned in the same sentence", () => {
  const result = heuristicExtract("monthly plan? I'd wash it weekly", {
    referenceDate: REF,
  });
  assert.equal(result.service, "subscription");
});

test("counts vehicles from digits and from words", () => {
  assert.equal(heuristicExtract("3 camionetas", { referenceDate: REF }).vehicle_count, 3);
  assert.equal(
    heuristicExtract("cinco vehiculos", { referenceDate: REF }).vehicle_count,
    5,
  );
  // No count stated is one vehicle, which is the overwhelmingly common case.
  assert.equal(
    heuristicExtract("necesito lavado", { referenceDate: REF }).vehicle_count,
    1,
  );
});

test("counts against every noun it can name a vehicle type from", () => {
  // The counting rules used to carry their own shorter noun list, so a word
  // the type patterns recognised could still be uncountable: "two SUVs" came
  // back as one vehicle alongside vehicle_types ["suv"], which reads like a
  // parse rather than a miss. Both now derive from one list.
  for (const [text, expected] of [
    ["detailing for two SUVs", 2],
    ["3 pickups please", 3],
    ["quote for 4 trucks", 4],
    ["dos motos", 2],
    ["cotizacion para 6 busetas", 6],
    ["wash for two sedans", 2],
  ] as const) {
    assert.equal(
      heuristicExtract(text, { referenceDate: REF }).vehicle_count,
      expected,
      `"${text}"`,
    );
  }
});

test("two named types mean two vehicles, not the one the first article states", () => {
  // "un sedan y una camioneta" states a count of one twice. The first `un`
  // won and a two-vehicle enquiry reached the CRM as a single car, next to a
  // vehicle_types of length two that said otherwise.
  const result = heuristicExtract("tengo un sedan y una camioneta, lavar los dos?", {
    referenceDate: REF,
  });
  assert.equal(result.vehicle_count, 2);
  assert.deepEqual([...result.vehicle_types].sort(), ["pickup", "sedan"]);

  // An explicit count larger than the number of named types still wins.
  assert.equal(
    heuristicExtract("siete carros de la flota", { referenceDate: REF }).vehicle_count,
    7,
  );
});

test("an ISO date is a date, not a phone number", () => {
  // Enough digits and separators to satisfy the phone pattern, so "para el
  // 2026-05-05" came back as the customer's contact. The lead then looked
  // answerable and went straight through.
  const result = heuristicExtract("quiero agendar un pulido para el 2026-05-05", {
    referenceDate: REF,
  });
  assert.equal(result.contact, null);
  assert.equal(result.requested_date, "2026-05-05");
});

test("a service word the sender negates does not classify the lead", () => {
  // "lavado mensual no, solo una vez" is a one-off wash. Matching `mensual`
  // filed it as a subscription, which is a different CRM pipeline.
  assert.equal(
    heuristicExtract("lavado mensual no, solo una vez", { referenceDate: REF }).service,
    "wash",
  );
  // The plain keyword still classifies when nothing cancels it.
  assert.equal(
    heuristicExtract("quiero lavado mensual", { referenceDate: REF }).service,
    "subscription",
  );
});

test("a warning light is a diagnostic request, not an unclassified lead", () => {
  assert.equal(
    heuristicExtract("Engine light is on, can someone look at it?", {
      referenceDate: REF,
    }).service,
    "inspection",
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

test("clamps notes so a pasted essay cannot bloat the CRM record", () => {
  const result = heuristicExtract("lavado ".repeat(500), { referenceDate: REF });
  assert.ok(result.notes.length <= 280);
});
