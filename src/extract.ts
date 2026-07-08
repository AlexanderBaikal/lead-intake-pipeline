/**
 * Rule-based extraction. Good enough to be useful, nowhere near good enough
 * for the messages people actually send.
 */

export interface Extracted {
  customer_name: string | null;
  contact: string | null;
  service: string;
  vehicle_count: number;
  requested_date: string | null;
  language: string;
  notes: string;
}

const SERVICE_PATTERNS: [RegExp, string][] = [
  [/(detail|pulido|encerado|wax|polish)/i, "detailing"],
  [/(repar|arregl|repair|fix)/i, "repair"],
  [/(revis|inspecc|inspection|check)/i, "inspection"],
  [/(lavado|lavar|wash|limpieza)/i, "wash"],
];

const ES_MARKERS = /(hola|necesito|quiero|precio|cuanto|lavado|manana|gracias)/i;

const iso = (d: Date) => d.toISOString().slice(0, 10);

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return next;
}

function detectDate(text: string, today: Date): string | null {
  const explicit = /(\d{4}-\d{2}-\d{2})/.exec(text);
  if (explicit) return explicit[1];
  if (/(ma[nñ]ana|tomorrow)/i.test(text)) return iso(addDays(today, 1));
  if (/(hoy|today)/i.test(text)) return iso(today);
  return null;
}

function detectContact(text: string): string | null {
  const email = /[\w.+-]+@[\w-]+\.[\w.]{2,}/.exec(text);
  if (email) return email[0];
  const phone = /(\+?\d[\d\s().-]{6,}\d)/.exec(text);
  if (phone) return phone[1].trim();
  return null;
}

function detectName(text: string): string | null {
  const m = /(me llamo|mi nombre es|soy|my name is|this is)\s+(\w+)/i.exec(text);
  return m ? m[2] : null;
}

export function extract(text: string, today = new Date()): Extracted {
  let service = "other";
  for (const [re, value] of SERVICE_PATTERNS) {
    if (re.test(text)) {
      service = value;
      break;
    }
  }

  const count = /(\d+)\s*(camionetas?|carros?|vehiculos?|cars?|suvs?)/i.exec(text);

  return {
    customer_name: detectName(text),
    contact: detectContact(text),
    service,
    vehicle_count: count ? Number(count[1]) : 1,
    requested_date: detectDate(text, today),
    language: ES_MARKERS.test(text) ? "es" : "en",
    notes: text.replace(/\s+/g, " ").trim().slice(0, 280),
  };
}
