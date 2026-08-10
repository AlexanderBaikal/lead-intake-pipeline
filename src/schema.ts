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
 * The words a vehicle type is written in. The field itself stays free text —
 * which taxonomy a CRM wants is its own business — but both extractors have to
 * answer in the same one, or the record depends on which of them ran: the
 * parser reads "camionetas" as `pickup` and a model, asked nothing in
 * particular, returns `pickup truck`, and the CRM ends up holding two
 * categories for one kind of vehicle.
 */
export const VEHICLE_TYPES = ["pickup", "suv", "sedan", "van", "motorcycle"] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

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
 * The shape travels; the descriptions do not, or not everywhere. The hosted
 * provider hands them to the model, Ollama compiles the schema into a sampling
 * grammar and keeps only the shape. So a convention that has to hold whichever
 * model ran is stated in the system prompt too — see src/llm/prompt.ts.
 *
 * Every field is nullable on purpose: a lead that omits the date is normal,
 * and inventing one is worse than leaving it null for a human to fill.
 */
export const ExtractedLead = z.object({
  customer_name: z.string().nullable(),
  contact: z.string().nullable(),
  service: z.enum(SERVICES),
  vehicle_count: z.number().int().min(1).max(50),
  vehicle_types: z
    .array(z.string())
    .describe(`the distinct types named, in these words: ${VEHICLE_TYPES.join(", ")}`),
  requested_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .describe("ISO date, resolved against the reference date given in the prompt"),
  urgency: z
    .enum(URGENCIES)
    .describe(
      "how urgently the customer asked, not how near the day they named: " +
        "asap only when they say it is urgent, today for the day the enquiry arrived, " +
        "this_week for any other day inside the coming week, flexible otherwise",
    ),
  language: z.enum(["es", "en", "other"]),
  notes: z.string(),
});
export type ExtractedLead = z.infer<typeof ExtractedLead>;
