/**
 * Token bucket sized to the downstream CRM's documented 60 writes/minute.
 *
 * Pacing beats reacting: a bucket keeps us under the limit, whereas retrying
 * on 429 means every burst pays a round trip to find out it was too fast, and
 * a queue that drains faster than the partner accepts just converts throughput
 * into error rate.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  /** Credit the tokens that have accrued since the last call, capped. */
  private refill(): void {
    const now = this.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsedSeconds * this.refillPerSecond,
    );
    this.lastRefill = now;
  }

  tryTake(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Milliseconds to wait for one token; 0 when it is available right now. */
  waitMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
  }

  async take(
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  ): Promise<void> {
    for (;;) {
      if (this.tryTake()) return;
      await sleep(this.waitMs());
    }
  }
}
