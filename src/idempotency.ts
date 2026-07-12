import { createHash } from "node:crypto";

import { IdempotencyKey, type LeadInput } from "./schema.js";

/**
 * Which key a delivery dedups on.
 *
 * Webhooks are at-least-once, so the same enquiry arrives more than once and
 * something has to decide that those are one lead. A caller that knows its own
 * delivery id says so; otherwise the content is the identity.
 */

/**
 * The fields are joined on NUL because it is the one character the inputs
 * cannot contain, so no contact string can impersonate a field boundary and
 * fold two different enquiries onto one key.
 */
const FIELD_SEPARATOR = "\u0000";

/**
 * Derived when the caller sends none. Two identical bodies from the same
 * channel within a delivery retry window are the same lead, not two.
 */
export function deriveKey(input: LeadInput): string {
  return createHash("sha256")
    .update([input.channel, input.contact ?? "", input.text].join(FIELD_SEPARATOR))
    .digest("hex");
}

export type ResolvedKey =
  { ok: true; key: string } | { ok: false; error: "invalid_idempotency_key" };

/**
 * Body field first, then the header, then the derived key.
 *
 * The header is held to the same rules as the field. Left unchecked, an empty
 * `Idempotency-Key:` counts as a key, and every request carrying one collapses
 * onto a single lead.
 */
export function resolveKey(input: LeadInput, header: string | undefined): ResolvedKey {
  if (header !== undefined && !IdempotencyKey.safeParse(header).success) {
    return { ok: false, error: "invalid_idempotency_key" };
  }
  return { ok: true, key: input.idempotency_key ?? header ?? deriveKey(input) };
}
