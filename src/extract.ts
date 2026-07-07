/**
 * First pass. Enough to see something structured come out the other end —
 * the real version will not be a pile of includes().
 */

export interface Extracted {
  service: string;
  vehicle_count: number;
  notes: string;
}

export function extract(text: string): Extracted {
  const lower = text.toLowerCase();

  let service = "other";
  if (lower.includes("lavado") || lower.includes("wash")) service = "wash";
  else if (lower.includes("pulido") || lower.includes("detail")) service = "detailing";
  else if (lower.includes("repar") || lower.includes("repair")) service = "repair";
  else if (lower.includes("revis") || lower.includes("inspect")) service = "inspection";

  const count = /(\d+)\s*(camionetas?|carros?|vehiculos?|cars?)/i.exec(text);

  return {
    service,
    vehicle_count: count ? Number(count[1]) : 1,
    notes: text.slice(0, 280),
  };
}
