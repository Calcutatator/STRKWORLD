import type { Address } from '@strkworld/privacy';
import { EXCHANGE_CATALOG } from '../panels/exchange/catalog.js';
import type { PoolStatsSnapshot, PoolStatsSource } from './pool-stats.js';

/**
 * The practice city's pool stats (D-076): fixed sample figures, so the
 * plaza can be seen working without a backend. Every surface that shows
 * them labels them as demo figures. Loaded lazily, and refused in a
 * production build (`PlazaProvider`).
 */

const WHOLE: Readonly<Record<string, string>> = Object.freeze({
  STRK: '1250000',
  ETH: '12.5',
  USDC: '98000',
  USDT: '4200',
  WBTC: '0.42',
  strkBTC: '0.18',
});

function baseUnits(whole: string, decimals: number): bigint {
  const [integer = '0', fraction = ''] = whole.split('.');
  return BigInt(integer + fraction.padEnd(decimals, '0').slice(0, decimals));
}

export const DEMO_POOL_STATS: PoolStatsSnapshot = Object.freeze({
  accounts: 1_248,
  deposits24h: 17,
  held: Object.freeze(EXCHANGE_CATALOG.map((asset) => Object.freeze({
    token: asset.token as Address,
    amount: baseUnits(WHOLE[asset.symbol] ?? '1', asset.decimals),
  }))),
});

export const DEMO_POOL_STATS_SOURCE: PoolStatsSource = Object.freeze({
  demo: true,
  async load(signal?: AbortSignal): Promise<PoolStatsSnapshot> {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    return DEMO_POOL_STATS;
  },
});
