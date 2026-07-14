/**
 * Token bucket sized to the downstream CRM's documented 60 writes/minute.
 *
 * Pacing beats reacting: a bucket keeps us under the limit, whereas retrying
 * on 429 means every burst pays a round trip to find out it was too fast.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
  }

  private refill(): void {
    const now = Date.now();
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

  async take(): Promise<void> {
    for (;;) {
      if (this.tryTake()) return;
      await new Promise((resolve) => setTimeout(resolve, this.waitMs()));
    }
  }
}
