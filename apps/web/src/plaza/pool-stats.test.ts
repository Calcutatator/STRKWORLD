import { describe, expect, it, vi } from 'vitest';
import { DEMO_POOL_STATS, DEMO_POOL_STATS_SOURCE } from './demo-pool-stats.js';
import {
  POOL_STATS_PATH,
  createBackendPoolStats,
  formatCompactUsd,
  formatExactUsd,
  formatHoldingLine,
  formatMonumentHoldingLine,
  formatPlazaCount,
  parsePoolStatsResponse,
  plazaStatsEvent,
} from './pool-stats.js';

/**
 * The Privacy Plaza's pool stats in the Shell (D-076; USD value D-080): one
 * same-origin read that carries nothing about the player, a strict parser,
 * and the figures the monument and its window show.
 */

const EMPTY = Object.freeze({
  accounts: null,
  deposits24h: null,
  valueUsd: null,
  topHoldings: null,
  valueAsOf: null,
  tokenCount: null,
});

describe('reading the pool stats (D-076, D-080)', () => {
  it('posts only the version to the same-origin route', async () => {
    const body = { ...EMPTY, accounts: 2932, deposits24h: 23 };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(body)));
    const source = createBackendPoolStats({ baseUrl: '/api', fetch: fetcher });
    await expect(source.load()).resolves.toEqual(body);
    expect(source.demo).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(`/api${POOL_STATS_PATH}`);
    expect(url).toBe('/api/v1/rpc/pool-stats');
    expect(init).toMatchObject({ method: 'POST', body: '{"v":1}', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' });
    expect(() => createBackendPoolStats({ baseUrl: 'https://elsewhere.example' })).toThrow(/same-origin/);
    expect(() => createBackendPoolStats({ baseUrl: '//elsewhere.example' })).toThrow(/same-origin/);
  });

  it('fails a read the backend refused', async () => {
    const source = createBackendPoolStats({ baseUrl: '/api', fetch: async () => new Response('{}', { status: 429 }) });
    await expect(source.load()).rejects.toThrow(/unavailable/);
  });

  it('parses aggregates strictly, keeping null parts null', () => {
    const full = {
      accounts: 2932,
      deposits24h: 0,
      valueUsd: 1_177_415.13,
      topHoldings: [{ symbol: 'xSTRK', usd: 453_000 }],
      valueAsOf: '2026-09-30T00:00:00.000Z',
      tokenCount: 40,
    };
    expect(parsePoolStatsResponse(full)).toEqual(full);
    expect(parsePoolStatsResponse(EMPTY)).toEqual(EMPTY);
    for (const bad of [
      null,
      [],
      { accounts: 1, deposits24h: 1 },
      { ...EMPTY, accounts: -1 },
      { ...EMPTY, accounts: 1.5 },
      { ...EMPTY, accounts: '1' },
      { ...EMPTY, valueUsd: -1 },
      { ...EMPTY, valueUsd: Number.NaN },
      { ...EMPTY, valueUsd: Number.POSITIVE_INFINITY },
      { ...EMPTY, valueUsd: '1177415' },
      { ...EMPTY, valueAsOf: 'not-a-timestamp' },
      { ...EMPTY, valueAsOf: '2026-09-30' },
      { ...EMPTY, tokenCount: -1 },
      { ...EMPTY, tokenCount: 1.5 },
      { ...EMPTY, tokenCount: '40' },
      { ...EMPTY, topHoldings: 'not-an-array' },
      { ...EMPTY, topHoldings: [{ symbol: 'STRK' }] },
      { ...EMPTY, topHoldings: [{ symbol: 'STRK', usd: -1 }] },
      { ...EMPTY, topHoldings: [{ symbol: 'STRK', usd: Number.NaN }] },
      { ...EMPTY, topHoldings: [{ symbol: '', usd: 1 }] },
      { ...EMPTY, topHoldings: [{ symbol: 'A'.repeat(17), usd: 1 }] },
      { ...EMPTY, topHoldings: Array.from({ length: 11 }, () => ({ symbol: 'X', usd: 1 })) },
    ]) {
      expect(() => parsePoolStatsResponse(bad), JSON.stringify(bad)).toThrow(/malformed/);
    }
    const accessor = Object.defineProperty({ ...EMPTY }, 'accounts', { get: () => 1, enumerable: true });
    expect(() => parsePoolStatsResponse(accessor)).toThrow(/malformed/);
  });

  it('offers demo figures that say they are demo figures', async () => {
    expect(DEMO_POOL_STATS_SOURCE.demo).toBe(true);
    await expect(DEMO_POOL_STATS_SOURCE.load()).resolves.toBe(DEMO_POOL_STATS);
    expect(DEMO_POOL_STATS.topHoldings).not.toBeNull();
    expect(DEMO_POOL_STATS.topHoldings!.length).toBeGreaterThan(0);
    expect(DEMO_POOL_STATS.topHoldings!.length).toBeLessThanOrEqual(10);
    expect(DEMO_POOL_STATS.valueUsd).toBeGreaterThan(0);
  });
});

describe('what the plaza shows (D-076, D-080)', () => {
  it('writes counts with separators, and USD figures compact and exact', () => {
    expect(formatPlazaCount(2932)).toBe('2,932');
    expect(formatPlazaCount(23)).toBe('23');
    expect(formatPlazaCount(1_234_567)).toBe('1,234,567');
    // Matches the lead's own examples exactly (strkprice.com's reported figures).
    expect(formatCompactUsd(1_177_415.13)).toBe('$1.18M');
    expect(formatCompactUsd(453_000)).toBe('$453K');
    expect(formatCompactUsd(198_000)).toBe('$198K');
    expect(formatCompactUsd(59_000)).toBe('$59K');
    expect(formatCompactUsd(11_000)).toBe('$11K');
    expect(formatCompactUsd(1_500_000_000)).toBe('$1.5B');
    expect(formatCompactUsd(42)).toBe('$42');
    expect(formatCompactUsd(0.4)).toBe('$0.40');
    expect(formatCompactUsd(0)).toBe('$0');
    expect(formatCompactUsd(-5)).toBe('$0');
    expect(formatCompactUsd(Number.NaN)).toBe('$0');
    expect(formatExactUsd(1_177_415.13)).toBe('$1,177,415');
    expect(formatExactUsd(0)).toBe('$0');
    expect(formatHoldingLine({ symbol: 'xSTRK', usd: 453_000 })).toBe('xSTRK $453K');
    expect(formatHoldingLine({ symbol: 'USDC', usd: 198_000 })).toBe('USDC $198K');
    expect(formatMonumentHoldingLine({ symbol: 'xSTRK', usd: 453_000 })).toBe('xSTRK · $453K');
  });

  it('pre-formats the monument figures, and null for anything unknown', () => {
    expect(plazaStatsEvent({
      accounts: 2932,
      deposits24h: 23,
      valueUsd: 1_177_415.13,
      topHoldings: [
        { symbol: 'xSTRK', usd: 453_000 },
        { symbol: 'USDC', usd: 198_000 },
      ],
      valueAsOf: '2026-09-30T00:00:00.000Z',
      tokenCount: 40,
    })).toEqual({
      accounts: '2,932',
      deposits24h: '23',
      valueUsd: '$1.18M',
      topHoldings: ['xSTRK · $453K', 'USDC · $198K'],
    });
    expect(plazaStatsEvent(null)).toEqual({ accounts: null, deposits24h: null, valueUsd: null, topHoldings: null });
    expect(plazaStatsEvent({ ...EMPTY, accounts: 0, topHoldings: [] })).toEqual({
      accounts: '0',
      deposits24h: null,
      valueUsd: null,
      topHoldings: null,
    });
  });
});
