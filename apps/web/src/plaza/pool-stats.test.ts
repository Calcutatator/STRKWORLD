import { describe, expect, it, vi } from 'vitest';
import type { WalletRoutePolicy } from '@strkworld/privacy';
import { EXCHANGE_CATALOG } from '../panels/exchange/catalog.js';
import { DEMO_POOL_STATS, DEMO_POOL_STATS_SOURCE } from './demo-pool-stats.js';
import {
  POOL_STATS_PATH,
  createBackendPoolStats,
  formatCompactAmount,
  formatPanelAmount,
  formatPlazaCount,
  parsePoolStatsResponse,
  plazaHeldLines,
  plazaStatsEvent,
  plazaTokens,
} from './pool-stats.js';

/**
 * The Privacy Plaza's pool stats in the Shell (D-076): one same-origin read
 * that carries nothing about the player, a strict parser, and the figures
 * the monument and its window show.
 */

const [STRK, ETH, USDC, USDT, WBTC, STRKBTC] = EXCHANGE_CATALOG.map((asset) => asset.token);
const E18 = 10n ** 18n;

function policyWithShield(tokens: readonly string[]): WalletRoutePolicy {
  return { enabledRoutes: ['shield'], allowedTokens: { shield: tokens } } as unknown as WalletRoutePolicy;
}

describe('reading the pool stats (D-076)', () => {
  it('posts only the version to the same-origin route', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ accounts: 2932, deposits24h: 23, held: null })));
    const source = createBackendPoolStats({ baseUrl: '/api', fetch: fetcher });
    await expect(source.load()).resolves.toEqual({ accounts: 2932, deposits24h: 23, held: null });
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
    expect(parsePoolStatsResponse({
      accounts: 2932,
      deposits24h: 0,
      held: [{ token: STRK, amount: '2561829878412000000000000' }],
    })).toEqual({ accounts: 2932, deposits24h: 0, held: [{ token: STRK, amount: 2561829878412000000000000n }] });
    expect(parsePoolStatsResponse({ accounts: null, deposits24h: null, held: null })).toEqual({ accounts: null, deposits24h: null, held: null });
    for (const bad of [
      null,
      [],
      { accounts: 1, deposits24h: 1 },
      { accounts: -1, deposits24h: 1, held: null },
      { accounts: 1.5, deposits24h: 1, held: null },
      { accounts: '1', deposits24h: 1, held: null },
      { accounts: 1, deposits24h: 1, held: [{ token: 'STRK', amount: '1' }] },
      { accounts: 1, deposits24h: 1, held: [{ token: STRK, amount: 1 }] },
      { accounts: 1, deposits24h: 1, held: [{ token: STRK, amount: '-1' }] },
      { accounts: 1, deposits24h: 1, held: [{ token: STRK, amount: '01' }] },
      { accounts: 1, deposits24h: 1, held: Array.from({ length: 17 }, () => ({ token: STRK, amount: '1' })) },
    ]) {
      expect(() => parsePoolStatsResponse(bad), JSON.stringify(bad)).toThrow(/malformed/);
    }
    const accessor = Object.defineProperty({ deposits24h: 1, held: null }, 'accounts', { get: () => 1, enumerable: true });
    expect(() => parsePoolStatsResponse(accessor)).toThrow(/malformed/);
  });

  it('offers demo figures that say they are demo figures', async () => {
    expect(DEMO_POOL_STATS_SOURCE.demo).toBe(true);
    await expect(DEMO_POOL_STATS_SOURCE.load()).resolves.toBe(DEMO_POOL_STATS);
    expect(DEMO_POOL_STATS.held).toHaveLength(EXCHANGE_CATALOG.length);
  });
});

describe('what the plaza shows (D-076)', () => {
  it("shows this build's shield allowlist, in its order, as far as the catalog describes it", () => {
    expect(plazaTokens(policyWithShield([USDC!, STRK!, '0x1234', STRK!])).map((token) => token.symbol)).toEqual(['USDC', 'STRK']);
    // The Railway list: STRK, ETH, USDC, USDT and WBTC.
    expect(plazaTokens(policyWithShield([STRK!, ETH!, USDC!, USDT!, WBTC!])).map((token) => token.symbol)).toEqual(['STRK', 'ETH', 'USDC', 'USDT', 'WBTC']);
    // No policy (demo, tests) restricts nothing.
    expect(plazaTokens(null).map((token) => token.symbol)).toEqual(EXCHANGE_CATALOG.map((asset) => asset.symbol));
    expect(plazaTokens({} as WalletRoutePolicy)).toEqual([]);
  });

  it('writes counts with separators and amounts in three figures, truncated', () => {
    expect(formatPlazaCount(2932)).toBe('2,932');
    expect(formatPlazaCount(23)).toBe('23');
    expect(formatPlazaCount(1_234_567)).toBe('1,234,567');
    expect(formatCompactAmount(2_561_829_878_412_000_000_000_000n, 18)).toBe('2.56M');
    expect(formatCompactAmount(18_976_348_000_000_000_000n, 18)).toBe('18.9');
    expect(formatCompactAmount(200_355_033_845n, 6)).toBe('200K');
    expect(formatCompactAmount(10_312_699_018n, 6)).toBe('10.3K');
    expect(formatCompactAmount(35_931_600n, 8)).toBe('0.359');
    expect(formatCompactAmount(1_000_000n * E18, 18)).toBe('1M');
    expect(formatCompactAmount(999n * E18, 18)).toBe('999');
    expect(formatCompactAmount(0n, 18)).toBe('0');
    expect(formatPanelAmount(2_561_829_878_412_000_000_000_000n, 18)).toBe('2,561,829.87');
    expect(formatPanelAmount(18_976_348_000_000_000_000n, 18)).toBe('18.97');
    expect(formatPanelAmount(35_931_600n, 8)).toBe('0.3593');
  });

  it('pre-formats the monument figures, and null for anything unknown', () => {
    const tokens = plazaTokens(policyWithShield([STRK!, WBTC!, STRKBTC!]));
    expect(plazaStatsEvent({
      accounts: 2932,
      deposits24h: 23,
      held: [
        { token: STRK!, amount: 2_561_829n * E18 },
        { token: WBTC!, amount: 35_931_600n },
        { token: ETH!, amount: 19n * E18 },
      ],
    }, tokens)).toEqual({ accounts: '2,932', deposits24h: '23', held: ['2.56M STRK', '0.359 WBTC'] });
    expect(plazaStatsEvent(null, tokens)).toEqual({ accounts: null, deposits24h: null, held: null });
    expect(plazaStatsEvent({ accounts: 0, deposits24h: null, held: [] }, tokens)).toEqual({ accounts: '0', deposits24h: null, held: null });
    expect(plazaHeldLines(null, tokens, formatPanelAmount)).toBeNull();
  });
});
