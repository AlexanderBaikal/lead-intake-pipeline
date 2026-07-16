import { config } from "../config.js";
import type { ExtractedLead } from "../schema.js";
import { localCalendarDay } from "../time.js";

/**
 * A deterministic parser for the same job the model does.
 *
 * It earns its keep twice over: it backs the offline provider (so the repo
 * runs and the evals score with no API key), and it is the fallback the
 * pipeline uses when a model call is refused, truncated, or blocked by the
 * budget ceiling. A lead parsed a bit worse still reaches the CRM; a lead lost
 * because the model was briefly unavailable does not.
 *
 * That second role is why this is not called `mock`: the same code runs in
 * production, on the path that matters most when something else has failed.
 */

const ES_MARKERS =
  /\b(hola|necesito|quiero|precio|cuanto|cuánto|lavado|camioneta|mañana|manana|gracias|por favor|buenas|carro|coche|auto|semana|urgente)\b/i;

/**
 * Ordered: the first match wins. Subscription sits above wash because
 * "monthly plan, I'd wash it weekly" is a plan enquiry, not a wash booking.
 * Stems (`lav\w*`, `wash\w*`) rather than exact words — real messages carry
 * conjugations and dropped letters, and "lavdo" is still a wash.
 */
const SERVICE_PATTERNS: ReadonlyArray<[RegExp, ExtractedLead["service"]]> = [
  [/\b(suscri\w*|subscription|mensual\w*|monthly plan|plan mensual)\b/i, "subscription"],
  [/\b(detail\w*|pulido|encerado|wax|polish|ceramic)\b/i, "detailing"],
  [/\b(repar\w*|arregl\w*|repair|fix|abolladur\w*|dent|scratch|ray[oó]n)\b/i, "repair"],
  [/\b(revis\w*|inspecci[oó]n|inspection|check-?up|diagn[oó]stico)\b/i, "inspection"],
  [/\b(lav\w*|wash\w*|limpieza|clean\w*)\b/i, "wash"],
];

/**
 * The nouns a vehicle can be called, grouped by the type they resolve to.
 * Plurals are explicit: `\bcamioneta\b` does not match "camionetas".
 */
const VEHICLE_NOUNS: ReadonlyArray<[string, string]> = [
  ["pickups?|pick-?ups?|camionetas?|trucks?", "pickup"],
  ["suvs?|4x4|jeeps?", "suv"],
  ["sedan(?:es|s)?|sed[aá]n|carros?|coches?|autos?|cars?", "sedan"],
  ["vans?|minivans?|busetas?", "van"],
  ["motos?|motorcycles?|bikes?", "motorcycle"],
];

const VEHICLE_PATTERNS: ReadonlyArray<[RegExp, string]> = VEHICLE_NOUNS.map(
  ([nouns, type]) => [new RegExp(`\\b(?:${nouns})\\b`, "i"), type],
);

/**
 * What a count can attach to: every noun above, plus the generic words a
 * fleet enquiry uses instead of naming a type.
 *
 * Built from the same list rather than typed out again — the second copy is
 * how "two SUVs" came to read as one vehicle, because `suvs` was known to the
 * type patterns and missing from the counting ones.
 */
const COUNTABLE = [
  ...VEHICLE_NOUNS.map(([nouns]) => nouns),
  "veh[ií]culos?|vehicles?|units?|unidades?",
].join("|");

// prettier-ignore
const NUMBER_WORDS: Record<string, number> = {
  un: 1, uno: 1, una: 1, one: 1,
  dos: 2, two: 2,
  tres: 3, three: 3,
  cuatro: 4, four: 4,
  cinco: 5, five: 5,
  seis: 6, six: 6,
  siete: 7, seven: 7,
  ocho: 8, eight: 8,
  nueve: 9, nine: 9,
  diez: 10, ten: 10,
};

// prettier-ignore
const WEEKDAYS: Record<string, number> = {
  domingo: 0, sunday: 0,
  lunes: 1, monday: 1,
  martes: 2, tuesday: 2,
  miercoles: 3, "miércoles": 3, wednesday: 3,
  jueves: 4, thursday: 4,
  viernes: 5, friday: 5,
  sabado: 6, "sábado": 6, saturday: 6,
};

const WEEKDAY_PATTERNS: ReadonlyArray<[RegExp, number]> = Object.entries(WEEKDAYS).map(
  ([word, day]) => [new RegExp(`\\b${word}\\b`, "i"), day],
);

const iso = (d: Date): string => d.toISOString().slice(0, 10);

const addDays = (d: Date, days: number): Date => {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

function detectDate(text: string, reference: Date): string | null {
  const explicit = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (explicit?.[1]) return explicit[1];

  if (/\b(pasado ma[nñ]ana|day after tomorrow)\b/i.test(text)) {
    return iso(addDays(reference, 2));
  }
  if (/\b(ma[nñ]ana|tomorrow)\b/i.test(text)) return iso(addDays(reference, 1));
  if (/\b(hoy|today|esta tarde|this afternoon|ahora|right now)\b/i.test(text)) {
    return iso(reference);
  }

  for (const [pattern, target] of WEEKDAY_PATTERNS) {
    if (!pattern.test(text)) continue;
    // "next Friday" from a Friday means the following one, not today.
    const delta = (target - reference.getUTCDay() + 7) % 7 || 7;
    return iso(addDays(reference, delta));
  }
  return null;
}

const COUNT_IN_DIGITS = new RegExp(`\\b(\\d{1,2})\\s*(?:${COUNTABLE})\\b`, "i");

/** Spelled-out counts, compiled once rather than per enquiry. */
const COUNT_IN_WORDS: ReadonlyArray<[RegExp, number]> = Object.entries(NUMBER_WORDS).map(
  ([word, value]) => [new RegExp(`\\b${word}\\s+(?:${COUNTABLE})\\b`, "i"), value],
);

function detectCount(text: string): number {
  const digits = COUNT_IN_DIGITS.exec(text);
  if (digits?.[1]) {
    const n = Number(digits[1]);
    if (n >= 1 && n <= 50) return n;
  }

  for (const [pattern, value] of COUNT_IN_WORDS) {
    if (pattern.test(text)) return value;
  }

  // No count stated is overwhelmingly one vehicle, not "unknown".
  return 1;
}

function detectContact(text: string): string | null {
  const email = /[\w.+-]+@[\w-]+\.[\w.]{2,}/.exec(text);
  if (email?.[0]) return email[0];
  const phone = /(\+?\d[\d\s().-]{6,}\d)/.exec(text);
  if (phone?.[1]) return phone[1].trim();
  return null;
}

function detectName(text: string): string | null {
  // The lead-in is matched case-insensitively ("This is Marcus" is as common
  // as "this is"), but the name itself must stay capitalised — otherwise
  // "soy el dueño" reads "el" as a first name.
  const patterns = [
    /\b(?:[Mm]e llamo|[Mm]i nombre es|[Ss]oy)\s+([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ]+)?)/,
    /\b(?:[Mm]y name is|[Tt]his is|[Ii] am|[Ii]'m)\s+([A-Z][\w]+(?:\s+[A-Z][\w]+)?)/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

export interface HeuristicOptions {
  /** The instant the enquiry arrived; relative dates resolve against it. */
  referenceDate?: Date;
  /** Contact the channel already knows, used when the text carries none. */
  contactHint?: string | null;
  /** The business calendar "mañana" is relative to. */
  timeZone?: string;
}

export function heuristicExtract(
  text: string,
  options: HeuristicOptions = {},
): ExtractedLead {
  // Collapse the arrival instant to the business calendar day before any day
  // arithmetic — see src/time.ts for why UTC would be wrong here.
  const reference = localCalendarDay(
    options.referenceDate ?? new Date(),
    options.timeZone ?? config.businessTimeZone,
  );

  let service: ExtractedLead["service"] = "other";
  for (const [re, value] of SERVICE_PATTERNS) {
    if (re.test(text)) {
      service = value;
      break;
    }
  }

  const vehicleTypes: string[] = [];
  for (const [re, label] of VEHICLE_PATTERNS) {
    if (re.test(text) && !vehicleTypes.includes(label)) vehicleTypes.push(label);
  }

  const urgency: ExtractedLead["urgency"] =
    /\b(urgente|urgent|asap|ya mismo|right now|ahora mismo|lo antes posible)\b/i.test(
      text,
    )
      ? "asap"
      : /\b(hoy|today|esta tarde|this afternoon)\b/i.test(text)
        ? "today"
        : /\b(esta semana|this week|ma[nñ]ana|tomorrow|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.test(
              text,
            )
          ? "this_week"
          : "flexible";

  return {
    customer_name: detectName(text),
    contact: detectContact(text) ?? options.contactHint ?? null,
    service,
    vehicle_count: detectCount(text),
    vehicle_types: vehicleTypes,
    requested_date: detectDate(text, reference),
    urgency,
    language: ES_MARKERS.test(text) ? "es" : "en",
    notes: text.replace(/\s+/g, " ").trim().slice(0, 280),
  };
}
