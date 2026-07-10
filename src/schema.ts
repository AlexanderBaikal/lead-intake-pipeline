import { z } from "zod";

export const SERVICES = [
  "wash",
  "detailing",
  "repair",
  "inspection",
  "subscription",
  "other"
] as const;

export const URGENCIES = ["asap", "today", "this_week", "flexible"] as const;

/** What a channel adapter posts to the intake endpoint. */
export const LeadInput = z.object({
  channel: z.enum(["web_form", "whatsapp", "email", "instagram"]),
  /** Whatever the human actually typed, untouched. */
  text: z.string().min(1).max(8_000),
  /** Phone or email, when the channel already knows it. */
  contact: z.string().max(200).optional()
});
export type LeadInput = z.infer<typeof LeadInput>;

/**
 * The shape the CRM needs.
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
  requested_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  urgency: z.enum(URGENCIES),
  language: z.enum(["es", "en", "other"]),
  notes: z.string()
});
export type ExtractedLead = z.infer<typeof ExtractedLead>;
