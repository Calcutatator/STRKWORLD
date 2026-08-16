export class AggregateMetrics {
  private requests = 0;
  private successes = 0;
  private failures = 0;
  private rateLimited = 0;

  request(): void { this.requests += 1; }
  success(): void { this.successes += 1; }
  failure(): void { this.failures += 1; }
  limited(): void { this.rateLimited += 1; }

  snapshot() {
    return {
      requests: this.requests,
      successes: this.successes,
      failures: this.failures,
      rateLimited: this.rateLimited,
    };
  }
}

export class AggregateRateLimiter {
  private windowStartedAt: number;
  private count = 0;

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {
    this.windowStartedAt = now();
  }

  take(): boolean {
    const current = this.now();
    if (current - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = current;
      this.count = 0;
    }
    if (this.count >= this.maxRequests) return false;
    this.count += 1;
    return true;
  }
}
