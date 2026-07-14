import assert from "node:assert/strict";
import { test } from "node:test";

import { TokenBucket } from "../src/ratelimit.js";

/** A clock we control, so the test asserts on pacing rather than on sleeping. */
function fakeClock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

test("hands out the burst capacity, then makes callers wait", () => {
  const clock = fakeClock();
  const bucket = new TokenBucket(10, 1, clock.now);

  for (let i = 0; i < 10; i += 1) {
    assert.equal(bucket.tryTake(), true, `token ${i} should be available`);
  }
  assert.equal(bucket.tryTake(), false, "the 11th must be refused");
  assert.ok(bucket.waitMs() > 0);
});

test("refills at the configured rate and never above capacity", () => {
  const clock = fakeClock();
  const bucket = new TokenBucket(5, 1, clock.now); // 1 token/second

  while (bucket.tryTake()) {
    /* drain */
  }
  clock.advance(3_000);
  for (let i = 0; i < 3; i += 1) assert.equal(bucket.tryTake(), true);
  assert.equal(bucket.tryTake(), false);

  // Idle for an hour: capacity must cap the refill, or the next burst would
  // dump an hour of saved-up tokens at the partner in one second.
  clock.advance(3_600_000);
  let granted = 0;
  while (bucket.tryTake()) granted += 1;
  assert.equal(granted, 5);
});

test("holds a 60/min partner limit over a simulated minute", () => {
  const clock = fakeClock();
  const bucket = new TokenBucket(10, 60 / 60, clock.now);

  let granted = 0;
  for (let second = 0; second < 60; second += 1) {
    // Ten callers arrive every second — far faster than the partner accepts.
    for (let i = 0; i < 10; i += 1) if (bucket.tryTake()) granted += 1;
    clock.advance(1_000);
  }
  assert.ok(
    granted <= 70,
    `granted ${granted}, expected the bucket to pace to ~60+burst`,
  );
  assert.ok(
    granted >= 60,
    `granted ${granted}, expected the bucket to use its allowance`,
  );
});
