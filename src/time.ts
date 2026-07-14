/**
 * Relative dates in an enquiry are relative to the *business* calendar, not to
 * UTC. A message sent at 22:30 in Panama arrives stamped with tomorrow's UTC
 * date, so "mañana" resolved against UTC lands two days out — the customer is
 * booked for the wrong day and nothing in the system looks broken.
 *
 * Everything downstream works in whole days, so the fix is to collapse the
 * instant to its local calendar date once, at the edge, and do the arithmetic
 * on that.
 *
 * The contract, exactly: `localCalendarDay` returns an instant whose **UTC**
 * fields carry the local calendar date, fixed at 12:00Z. Read it with the UTC
 * getters (`getUTCDate`, `getUTCDay`, `toISOString().slice(0, 10)`) — which is
 * what the extraction step does. It is a carrier for a date, not a timestamp
 * for a moment: formatting it in some other zone is meaningless, and at UTC+12
 * (Auckland) noon UTC has already rolled over to the next local day.
 *
 * Noon rather than midnight because a midnight-UTC carrier renders as the
 * previous day everywhere west of Greenwich — the classic off-by-one. Noon
 * leaves twelve hours of slack in both directions, so a stray local-time
 * format still prints the right date anywhere in the Americas.
 */

/** The local calendar date at `instant`, as `YYYY-MM-DD`. */
export function localDateISO(instant: Date, timeZone: string): string {
  // en-CA renders ISO-ordered dates, which is why it is the locale of choice
  // here rather than a manual assembly of the parts.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** The local calendar date as a Date pinned to noon UTC. */
export function localCalendarDay(instant: Date, timeZone: string): Date {
  return new Date(`${localDateISO(instant, timeZone)}T12:00:00Z`);
}
