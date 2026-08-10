import { config } from "../config.js";
import { VEHICLE_TYPES } from "../schema.js";
import { localDateISO } from "../time.js";
import type { ExtractRequest } from "./provider.js";

/**
 * One definition, because both model providers send it. Two copies drift, and
 * the evals only mean something if a local model and a hosted one were asked
 * the same question.
 *
 * Two fields carry a convention the words alone do not imply, so they are spelt
 * out rather than left to be inferred. Left unsaid, "mañana temprano" came back
 * `asap` from the model and `this_week` from the parser — a disagreement about
 * what the labels mean, not about what the customer wrote, and one that lands
 * on a person's desk on every enquiry naming tomorrow.
 */
export const SYSTEM = [
  "You normalize inbound service enquiries for a vehicle-care business in Panama.",
  "Enquiries arrive as free text, in Spanish or English, often mixed, misspelled, or truncated.",
  "Extract only what the text actually says. Leave a field null rather than guessing it:",
  "an unfilled field costs a human ten seconds, an invented one costs a wrong appointment.",
  "Resolve relative dates ('mañana', 'next Friday') against the reference date given in the message.",
  "requested_date is a calendar date or null, never a word: 'asap' is an urgency, and an",
  "enquiry that names no day has no date.",
  "urgency is how urgently the customer asked, not how near the day they named.",
  "Take the first that applies: 'asap' when the enquiry says it is urgent",
  "(urgente, lo antes posible, ya mismo, right now); 'today' when it names the reference date",
  "(hoy, esta tarde); 'this_week' when it names any other day inside the coming week,",
  "'mañana' among them; 'flexible' when it names no day, or one further out than that.",
  "A time of day ('temprano', 'first thing') says when, not how urgently.",
  `vehicle_types uses these words and no others: ${VEHICLE_TYPES.join(", ")}.`,
  "One entry per distinct type named — 'camioneta' is a pickup, and a car named no more",
  "precisely than 'el carro' or 'my car' is a sedan — and an empty list when none is named at all.",
].join(" ");

/**
 * Assembled stable-part-first: the instructions are byte-identical across
 * leads and only the tail varies. That ordering is what a prefix cache needs,
 * and it costs nothing when the provider has no cache.
 */
export function userPrompt(request: ExtractRequest): string {
  // The business calendar day, not the UTC one — see src/time.ts.
  const reference = localDateISO(request.referenceDate, config.businessTimeZone);
  return [
    `Reference date (today, ${config.businessTimeZone}): ${reference}`,
    request.contactHint ? `Contact known from the channel: ${request.contactHint}` : null,
    "Enquiry:",
    request.text,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
