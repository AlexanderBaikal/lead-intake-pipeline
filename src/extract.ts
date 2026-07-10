import type { ExtractedLead } from "./schema.js";

/**
 * Rule-based extraction. Good enough to be useful, nowhere near good enough
 * for the messages people actually send.
 */

const ES_MARKERS =
  /\b(hola|necesito|quiero|precio|cuanto|cuánto|lavado|camioneta|mañana|manana|gracias|por favor|buenas|carro|coche|auto|semana|urgente)\b/i;

/** Ordered: the first match wins. */
const SERVICE_PATTERNS: ReadonlyArray<[RegExp, ExtractedLead["service"]]> = [
  [/\b(lavado|lavar|wash|limpieza)\b/i, "wash"],
  [/\b(detailing|pulido|encerado|wax|polish|ceramic)\b/i, "detailing"],
  [/\b(reparar|arreglar|repair|fix|dent|scratch)\b/i, "repair"],
  [/\b(revisar|inspeccion|inspección|inspection|check-?up)\b/i, "inspection"],
  [/\b(suscripcion|suscripción|subscription|mensual|monthly plan)\b/i, "subscription"]
];

const VEHICLE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b(pickup|pick-up|camioneta|truck)\b/i, "pickup"],
  [/\b(suv|4x4|jeep)\b/i, "suv"],
  [/\b(sedan|sedán|carro|coche|auto|car)\b/i, "sedan"],
  [/\b(van|minivan|buseta)\b/i, "van"],
  [/\b(moto|motorcycle|bike)\b/i, "motorcycle"]
];

const COUNTABLE =
  "camionetas?|carros?|coches?|autos?|cars?|veh[ií]culos?|vehicles?|motos?";

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
  diez: 10, ten: 10
};

// prettier-ignore
const WEEKDAYS: Record<string, number> = {
  domingo: 0, sunday: 0,
  lunes: 1, monday: 1,
  martes: 2, tuesday: 2,
  miercoles: 3, "miércoles": 3, wednesday: 3,
  jueves: 4, thursday: 4,
  viernes: 5, friday: 5,
  sabado: 6, "sábado": 6, saturday: 6
};

const iso = (d: Date): string => d.toISOString().slice(0, 10);

const addDays = (d: Date, days: number): Date => {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

function detectDate(text: string, reference: Date): string | null {
  const explicit = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (explicit) return explicit[1];

  if (/\b(pasado ma[nñ]ana|day after tomorrow)\b/i.test(text)) {
    return iso(addDays(reference, 2));
  }
  if (/\b(ma[nñ]ana|tomorrow)\b/i.test(text)) return iso(addDays(reference, 1));
  if (/\b(hoy|today|esta tarde|this afternoon|ahora|right now)\b/i.test(text)) {
    return iso(reference);
  }

  for (const [word, target] of Object.entries(WEEKDAYS)) {
    if (!new RegExp(`\\b${word}\\b`, "i").test(text)) continue;
    const delta = (target - reference.getUTCDay() + 7) % 7;
    return iso(addDays(reference, delta));
  }
  return null;
}

function detectCount(text: string): number {
  const digits = new RegExp(`\\b(\\d{1,2})\\s*(?:${COUNTABLE})\\b`, "i").exec(text);
  if (digits) {
    const n = Number(digits[1]);
    if (n >= 1 && n <= 50) return n;
  }

  for (const [word, value] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\s+(?:${COUNTABLE})\\b`, "i").test(text)) return value;
  }

  // No count stated is overwhelmingly one vehicle, not "unknown".
  return 1;
}

function detectContact(text: string): string | null {
  const email = /[\w.+-]+@[\w-]+\.[\w.]{2,}/.exec(text);
  if (email) return email[0];
  const phone = /(\+?\d[\d\s().-]{6,}\d)/.exec(text);
  if (phone) return phone[1].trim();
  return null;
}

function detectName(text: string): string | null {
  const m = /\b(?:me llamo|mi nombre es|soy|my name is|this is|i am|i'm)\s+(\w+(?:\s+\w+)?)/i.exec(text);
  return m ? m[1].trim() : null;
}

export interface ExtractOptions {
  referenceDate?: Date;
  contactHint?: string | null;
}

export function extract(text: string, options: ExtractOptions = {}): ExtractedLead {
  const reference = options.referenceDate ?? new Date();

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
    /\b(urgente|urgent|asap|ya mismo|right now|ahora mismo|lo antes posible)\b/i.test(text)
      ? "asap"
      : /\b(hoy|today|esta tarde|this afternoon)\b/i.test(text)
        ? "today"
        : /\b(esta semana|this week|ma[nñ]ana|tomorrow|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.test(text)
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
    notes: text.replace(/\s+/g, " ").trim().slice(0, 280)
  };
}
