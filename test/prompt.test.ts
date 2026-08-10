import assert from "node:assert/strict";
import { test } from "node:test";

import { SYSTEM } from "../src/llm/prompt.js";
import { URGENCIES, VEHICLE_TYPES } from "../src/schema.js";

/**
 * The vocabularies the schema names and nothing enforces.
 *
 * A model is handed the shape either way — as a structured output format or as
 * a sampling grammar — so a label nobody defined does not fail anywhere. It
 * comes back as a confident wrong answer instead: "mañana temprano" read `asap`
 * from the model and `this_week` from the parser, which is not a disagreement
 * about the enquiry but about what the words mean, and it stopped the lead in
 * front of a person. Adding a level, or a vehicle type, without saying what it
 * means should fail the build rather than the next enquiry.
 */

test("the system prompt accounts for every urgency level", () => {
  for (const level of URGENCIES) {
    assert.ok(SYSTEM.includes(level), `the prompt never says when "${level}" applies`);
  }
});

test("the system prompt hands over the whole vehicle vocabulary", () => {
  for (const type of VEHICLE_TYPES) {
    assert.ok(
      SYSTEM.includes(type),
      `the prompt never gives the model the word "${type}"`,
    );
  }
});
