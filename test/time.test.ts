import assert from "node:assert/strict";
import { test } from "node:test";

import { extract } from "../src/llm/mock.js";
import { localCalendarDay, localDateISO } from "../src/time.js";

/**
 * The bug these tests pin down showed up end-to-end, not in review: a WhatsApp
 * message sent at 22:30 in Panama carries a UTC timestamp that is already the
 * next day, so "mañana" resolved to two days out. The booking looked valid,
 * which is what made it worth a regression test.
 */

const LATE_EVENING_PANAMA = new Date("2026-04-12T03:27:00Z"); // 22:27 on Apr 11 local

test("collapses an instant to the local calendar date, not the UTC one", () => {
  assert.equal(localDateISO(LATE_EVENING_PANAMA, "America/Panama"), "2026-04-11");
  assert.equal(localDateISO(LATE_EVENING_PANAMA, "UTC"), "2026-04-12");
});

test("the carrier holds the local date in its UTC fields, at noon", () => {
  // This is the whole contract, and it holds in every zone — including the
  // UTC+12 edge where reading the carrier as a local time would not.
  for (const zone of [
    "Pacific/Auckland",
    "Pacific/Midway",
    "America/Panama",
    "Europe/Madrid",
    "Asia/Tokyo",
    "UTC",
  ]) {
    const day = localCalendarDay(LATE_EVENING_PANAMA, zone);
    assert.equal(
      day.toISOString().slice(0, 10),
      localDateISO(LATE_EVENING_PANAMA, zone),
      `carrier lost the date in ${zone}`,
    );
    assert.equal(day.toISOString().slice(10), "T12:00:00.000Z", `not noon in ${zone}`);
  }
});

test("noon, not midnight — a midnight carrier reads as yesterday in the Americas", () => {
  const noon = localCalendarDay(LATE_EVENING_PANAMA, "America/Panama");
  assert.equal(localDateISO(noon, "America/Panama"), "2026-04-11");

  const midnight = new Date("2026-04-11T00:00:00Z");
  assert.equal(localDateISO(midnight, "America/Panama"), "2026-04-10");
});

test("'mañana' sent late at night means the customer's tomorrow", () => {
  const result = extract("lavado mañana por favor", {
    referenceDate: LATE_EVENING_PANAMA,
    timeZone: "America/Panama",
  });
  assert.equal(result.requested_date, "2026-04-12");

  // The same instant read as UTC is the regression: one day too far out.
  const naive = extract("lavado mañana por favor", {
    referenceDate: LATE_EVENING_PANAMA,
    timeZone: "UTC",
  });
  assert.equal(naive.requested_date, "2026-04-13");
});

test("a weekday is resolved from the local day of week", () => {
  // Locally 2026-04-11 is a Saturday; in UTC the same instant is Sunday the
  // 12th, from which "lunes" would be one day nearer.
  assert.equal(
    extract("nos vemos el lunes", {
      referenceDate: LATE_EVENING_PANAMA,
      timeZone: "America/Panama",
    }).requested_date,
    "2026-04-13",
  );
});
