import assert from "node:assert/strict";
import { test } from "node:test";

import { promote } from "../src/agreement.js";
import { REVIEWABLE_FIELDS } from "../src/review.js";

const RULES = { threshold: 0.95, minDecisions: 20 };

const by = (rows: ReturnType<typeof promote>, field: string) =>
  rows.find((row) => row.field === field)!;

test("every reviewable field is reported, measured or not", () => {
  const rows = promote([], RULES);
  assert.equal(rows.length, REVIEWABLE_FIELDS.length);
});

test("an unmeasured field has no rate and is not promoted", () => {
  const row = by(promote([], RULES), "service");
  assert.equal(row.rate, null);
  assert.equal(row.auto, false);
});

test("a field left alone often enough, over enough decisions, stops being asked", () => {
  const rows = promote([{ field: "urgency", decided: 40, accepted: 39 }], RULES);
  assert.equal(by(rows, "urgency").auto, true);
  assert.equal(by(rows, "urgency").rate, 39 / 40);
});

test("a perfect record on too few decisions is not evidence", () => {
  const rows = promote([{ field: "urgency", decided: 3, accepted: 3 }], RULES);
  assert.equal(by(rows, "urgency").rate, 1);
  assert.equal(by(rows, "urgency").auto, false);
});

test("a field people keep correcting keeps coming back", () => {
  const rows = promote([{ field: "contact", decided: 100, accepted: 80 }], RULES);
  assert.equal(by(rows, "contact").auto, false);
});

test("promotion is per field, not for the extractor as a whole", () => {
  const rows = promote(
    [
      { field: "urgency", decided: 50, accepted: 50 },
      { field: "contact", decided: 50, accepted: 10 },
    ],
    RULES,
  );
  assert.equal(by(rows, "urgency").auto, true);
  assert.equal(by(rows, "contact").auto, false);
});
