import { z } from "zod";

export const SERVICES = [
  "wash",
  "detailing",
  "repair",
  "inspection",
  "subscription",
  "other",
] as const;

export const URGENCIES = ["asap", "today", "this_week", "flexible"] as const;

/**
 * Caller-supplied dedup key. One definition because it arrives two ways — as
 * this field or as the `Idempotency-Key` header — and a header held to looser
 * rules than the field is how an empty string becomes a valid key that every
 * request shares.
 */
export const IdempotencyKey = z.string().min(8).max(200);

/** What a channel adapter posts to the intake endpoint. */
export const LeadInput = z.object({
  channel: z.enum(["web_form", "whatsapp", "email", "instagram"]),
  /** Whatever the human actually typed, untouched. */
  text: z.string().min(1).max(8_000),
  /** Phone or email, when the channel already knows it. */
  contact: z.string().max(200).optional(),
  /** Optional: absent, the server derives one from (channel, contact, text). */
  idempotency_key: IdempotencyKey.optional(),
});
export type LeadInput = z.infer<typeof LeadInput>;

/**
 * The shape the CRM needs. This schema is handed to the model as a structured
 * output format, so the model cannot return a different shape — the only
 * failure left to handle is a refusal or a truncation, not a parse error.
 *
 * Every field is nullable on purpose: a lead that omits the date is normal,
 * and inventing one is worse than leaving it null for a human to fill.
 */
export const ExtractedLead = z.object({
  customer_name: z.string().nullable(),
  contact: z.string().nullable(),
  service: z.enum(SERVICES),
  vehicle_count: z.number().int().min(1).max(50),
  vehicle_types: z.array(z.string()),
  requested_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .describe("ISO date, resolved against the reference date given in the prompt"),
  urgency: z.enum(URGENCIES),
  language: z.enum(["es", "en", "other"]),
  notes: z.string(),
});
export type ExtractedLead = z.infer<typeof ExtractedLead>;
