import type { PoolStatsSnapshot, PoolStatsSource } from './pool-stats.js';

/**
 * The practice city's pool stats (D-076; USD value D-080): fixed sample
 * figures, so the plaza can be seen working without a backend. Every surface
 * that shows them labels them as demo figures. Loaded lazily, and refused in
 * a production build (`PlazaProvider`).
 */

export const DEMO_POOL_STATS: PoolStatsSnapshot = Object.freeze({
  accounts: 1_248,
  deposits24h: 17,
  valueUsd: 842_000,
  topHoldings: Object.freeze([
    Object.freeze({ symbol: 'xSTRK', usd: 320_000 }),
    Object.freeze({ symbol: 'USDC', usd: 210_000 }),
    Object.freeze({ symbol: 'STRK', usd: 180_000 }),
    Object.freeze({ symbol: 'ETH', usd: 90_000 }),
    Object.freeze({ symbol: 'WBTC', usd: 42_000 }),
  ]),
  valueAsOf: '2026-09-29T00:00:00.000Z',
  tokenCount: 12,
});

export const DEMO_POOL_STATS_SOURCE: PoolStatsSource = Object.freeze({
  demo: true,
  async load(signal?: AbortSignal): Promise<PoolStatsSnapshot> {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    return DEMO_POOL_STATS;
  },
});
