export class AggregateMetrics {
  private requests = 0;
  private successes = 0;
  private failures = 0;
  private rateLimited = 0;
  private budgetExhausted = 0;
  private queueRejected = 0;

  request(): void { this.requests += 1; }
  success(): void { this.successes += 1; }
  failure(): void { this.failures += 1; }
  limited(): void { this.rateLimited += 1; }
  budgetLimited(): void { this.budgetExhausted += 1; }
  queueLimited(): void { this.queueRejected += 1; }

  snapshot() {
    return {
      requests: this.requests,
      successes: this.successes,
      failures: this.failures,
      rateLimited: this.rateLimited,
      budgetExhausted: this.budgetExhausted,
      queueRejected: this.queueRejected,
    };
  }
}

export interface RequestRateLimiterPort {
  take(): boolean | Promise<boolean>;
}

export interface SponsorshipBudgetPort {
  take(amount: bigint): boolean | Promise<boolean>;
}

/** Aggregate token-denominated sponsorship budget. It retains no request key. */
export class AggregateBudget implements SponsorshipBudgetPort {
  private windowStartedAt: number;
  private spent = 0n;

  constructor(
    private readonly maxFeeAmount: bigint,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {
    this.windowStartedAt = now();
  }

  take(amount: bigint): boolean {
    const current = this.now();
    if (current - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = current;
      this.spent = 0n;
    }
    if (amount < 0n || this.spent + amount > this.maxFeeAmount) return false;
    this.spent += amount;
    return true;
  }
}

export class AggregateRateLimiter implements RequestRateLimiterPort {
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
