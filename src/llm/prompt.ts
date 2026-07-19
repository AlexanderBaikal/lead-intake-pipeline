import { config } from "../config.js";
import { localDateISO } from "../time.js";
import type { ExtractRequest } from "./provider.js";

/**
 * One definition, because both model providers send it. Two copies drift, and
 * the evals only mean something if a local model and a hosted one were asked
 * the same question.
 */
export const SYSTEM = [
  "You normalize inbound service enquiries for a vehicle-care business in Panama.",
  "Enquiries arrive as free text, in Spanish or English, often mixed, misspelled, or truncated.",
  "Extract only what the text actually says. Leave a field null rather than guessing it:",
  "an unfilled field costs a human ten seconds, an invented one costs a wrong appointment.",
  "Resolve relative dates ('mañana', 'next Friday') against the reference date given in the message.",
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
