import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DecisionInput,
  mergeDecisions,
  openQuestions,
  REJECTABLE_FIELDS,
  type Decision,
} from "../src/review.js";
import { ExtractedLead } from "../src/schema.js";

const TODAY = "2026-04-11";

const lead = (over: Partial<ExtractedLead> = {}): ExtractedLead => ({
  customer_name: "Ana",
  contact: "+507 6000-0000",
  service: "wash",
  vehicle_count: 1,
  vehicle_types: ["sedan"],
  requested_date: "2026-04-12",
  urgency: "this_week",
  language: "es",
  notes: "",
  ...over,
});

const ask = (
  over: Parameters<typeof openQuestions>[0] extends never
    ? never
    : Partial<Parameters<typeof openQuestions>[0]>,
) =>
  openQuestions({
    extracted: lead(),
    alternative: null,
    contactHint: null,
    today: TODAY,
    settled: new Set(),
    ...over,
  });

test("a lead the machine can answer raises nothing", () => {
  assert.deepEqual(ask({}), []);
});

test("no contact anywhere means there is no reply path", () => {
  const flags = ask({ extracted: lead({ contact: null }) });
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.field, "contact");
  assert.equal(flags[0]!.reason, "unreachable");
});

test("a contact the channel already knew is not a question for a human", () => {
  assert.deepEqual(
    ask({ extracted: lead({ contact: null }), contactHint: "a@b.co" }),
    [],
  );
});

test("an unclassified service is held, because the CRM routes on it", () => {
  const flags = ask({ extracted: lead({ service: "other" }) });
  assert.equal(flags[0]?.reason, "unclassified");
});

test("a date resolved before the enquiry arrived is impossible, not a preference", () => {
  const flags = ask({ extracted: lead({ requested_date: "2026-04-10" }) });
  assert.equal(flags[0]?.field, "requested_date");
  assert.equal(flags[0]?.reason, "impossible_date");

  // The day itself is fine: same-day requests are the common case.
  assert.deepEqual(ask({ extracted: lead({ requested_date: TODAY }) }), []);
});

test("extractors that disagree on where the lead goes raise it", () => {
  const flags = ask({
    extracted: lead({ service: "detailing" }),
    alternative: lead({ service: "repair" }),
  });
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.reason, "disagreement");
  assert.equal(flags[0]!.value, "detailing");
  assert.equal(flags[0]!.alternative, "repair");
});

test("a name only one extractor found is not worth a person's time", () => {
  // Disagreement is only asked about where it changes routing. A missing name
  // is the parser being a parser.
  assert.deepEqual(
    ask({ extracted: lead(), alternative: lead({ customer_name: null }) }),
    [],
  );
});

test("one flag per field: the loudest reason wins, the rest stay quiet", () => {
  const flags = ask({
    extracted: lead({ requested_date: "2026-04-01" }),
    alternative: lead({ requested_date: "2026-04-20" }),
  });
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.reason, "impossible_date");
});

test("settled fields are not asked again", () => {
  assert.deepEqual(
    ask({ extracted: lead({ contact: null }), settled: new Set(["contact"]) }),
    [],
  );
});

test("a correction replaces the value, an acceptance leaves it alone", () => {
  const decisions: Decision[] = [
    { field: "service", verdict: "corrected", value: "repair" },
    { field: "customer_name", verdict: "accepted", value: "ignored" },
  ];
  const merged = mergeDecisions(lead(), decisions);
  assert.equal(merged.service, "repair");
  assert.equal(merged.customer_name, "Ana");
});

test("a rejection survives the machine finding the value again", () => {
  const decisions: Decision[] = [{ field: "contact", verdict: "rejected" }];

  // The re-run produces a contact once more — the tombstone has to win.
  const rerun = mergeDecisions(lead({ contact: "+507 6111-1111" }), decisions);
  assert.equal(rerun.contact, null);
});

test("merged output still satisfies the CRM contract", () => {
  const merged = mergeDecisions(lead(), [
    { field: "requested_date", verdict: "rejected" },
  ]);
  assert.doesNotThrow(() => ExtractedLead.parse(merged));
});

test("only nullable fields can be rejected outright", () => {
  const reject = (field: string) =>
    DecisionInput.safeParse({ decisions: [{ field, verdict: "rejected" }] }).success;

  for (const field of REJECTABLE_FIELDS) {
    assert.equal(reject(field), true, `${field} should be rejectable`);
  }
  // `service` has no empty value in the schema, so "wrong" has to be a correction.
  assert.equal(reject("service"), false);
  assert.equal(reject("urgency"), false);
  assert.equal(reject("vehicle_count"), false);
});

test("decisions on fields nobody reviews are refused", () => {
  const parsed = DecisionInput.safeParse({
    decisions: [{ field: "notes", verdict: "corrected", value: "x" }],
  });
  assert.equal(parsed.success, false);
});
