import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveKey, resolveKey } from "../src/idempotency.js";
import type { LeadInput } from "../src/schema.js";

const lead = (over: Partial<LeadInput> = {}): LeadInput => ({
  channel: "whatsapp",
  text: "hola, necesito un lavado",
  ...over,
});

test("the same enquiry delivered twice derives the same key", () => {
  assert.equal(deriveKey(lead()), deriveKey(lead()));
});

test("a different channel, contact or text derives a different key", () => {
  const base = deriveKey(lead({ contact: "+50761234567" }));
  assert.notEqual(base, deriveKey(lead({ contact: "+50761234568" })));
  assert.notEqual(base, deriveKey(lead({ contact: "+50761234567", channel: "email" })));
  assert.notEqual(base, deriveKey(lead({ contact: "+50761234567", text: "otra cosa" })));
});

test("no field can impersonate a boundary and fold two enquiries into one", () => {
  // The reason the parts are joined on NUL rather than a printable character:
  // with a "|" separator these two collapse onto one key and the second
  // customer's enquiry is silently answered with the first one's lead.
  assert.notEqual(
    deriveKey(lead({ contact: "a|b", text: "c" })),
    deriveKey(lead({ contact: "a", text: "b|c" })),
  );
});

test("the body field wins, then the header, then the derived key", () => {
  const header = "header-supplied-key";
  const body = "body-supplied-key";

  assert.deepEqual(resolveKey(lead({ idempotency_key: body }), header), {
    ok: true,
    key: body,
  });
  assert.deepEqual(resolveKey(lead(), header), { ok: true, key: header });
  assert.deepEqual(resolveKey(lead(), undefined), { ok: true, key: deriveKey(lead()) });
});

test("an empty header is rejected, not accepted as a key", () => {
  // The bug this pins: "" passed a `typeof === "string"` check, so every
  // request sending a blank Idempotency-Key deduped onto one shared lead.
  const result = resolveKey(lead(), "");
  assert.equal(result.ok, false);

  const stillDerives = resolveKey(lead(), undefined);
  assert.equal(stillDerives.ok, true);
});

test("a header that breaks the documented bounds is rejected", () => {
  assert.equal(resolveKey(lead(), "short").ok, false);
  assert.equal(resolveKey(lead(), "x".repeat(201)).ok, false);
  assert.equal(resolveKey(lead(), "x".repeat(200)).ok, true);
});
