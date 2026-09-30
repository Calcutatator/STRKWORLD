import type { ShellEvents } from '@strkworld/shared';

/**
 * The Privacy Plaza's pool stats (D-076; USD value D-080), as the Shell reads
 * and shows them.
 *
 * Public, pool-wide aggregates from the backend's cache: accounts registered,
 * deposits in the last day, and the pool's total USD value with its highest-
 * value holdings. The value is read by the backend from Voyager through
 * strkprice.com, a public aggregate with no key and no user data (D-080);
 * the browser never calls it directly. Nothing here is about the player: the
 * request carries only a version, and the answer holds only counts, a total
 * and per-symbol totals. The World gets them pre-formatted (`plaza:stats`),
 * the way it gets the HUD balance.
 */

/** D-080: one token's share of the pool's value, as the backend reports it. */
export interface PoolTokenValue {
  readonly symbol: string;
  readonly usd: number;
}

export interface PoolStatsSnapshot {
  readonly accounts: number | null;
  readonly deposits24h: number | null;
  /** D-080: the pool's total USD value. */
  readonly valueUsd: number | null;
  /** D-080: the highest-value tokens the pool holds, most valuable first. */
  readonly topHoldings: readonly PoolTokenValue[] | null;
  /** D-080: when the value was last refreshed, as an ISO timestamp. */
  readonly valueAsOf: string | null;
  /** D-080: how many distinct tokens the pool holds, priced or not. */
  readonly tokenCount: number | null;
}

export interface PoolStatsSource {
  /** Demo figures, which every surface that shows them must label as such. */
  readonly demo: boolean;
  load(signal?: AbortSignal): Promise<PoolStatsSnapshot>;
}

/** The backend route, under the same-origin `/api` prefix the edge strips. */
export const POOL_STATS_PATH = '/v1/rpc/pool-stats';

/** Matches the backend's own cap, kept here as a sanity backstop on the answer. */
const MAX_TOP_HOLDINGS = 10;
const MAX_SYMBOL_LENGTH = 16;
const MAX_COUNT = 1_000_000_000_000;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The production source: one same-origin POST carrying nothing but `{ v: 1 }`. */
export function createBackendPoolStats(options: { baseUrl: string; fetch?: FetchLike }): PoolStatsSource {
  const { baseUrl } = options;
  if (typeof baseUrl !== 'string' || !baseUrl.startsWith('/') || baseUrl.startsWith('//')) {
    throw new Error('The pool stats must be read from the same-origin backend path.');
  }
  const injected = options.fetch;
  const fetcher: FetchLike = injected
    ? (input, init) => Reflect.apply(injected, undefined, [input, init]) as Promise<Response>
    : (input, init) => globalThis.fetch(input, init);
  const url = `${baseUrl.replace(/\/$/, '')}${POOL_STATS_PATH}`;
  return Object.freeze({
    demo: false,
    async load(signal?: AbortSignal): Promise<PoolStatsSnapshot> {
      const response = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ v: 1 }),
        cache: 'no-store',
        credentials: 'same-origin',
        referrerPolicy: 'no-referrer',
        signal,
      });
      if (!response.ok) throw new Error('The pool stats are unavailable.');
      return parsePoolStatsResponse(await response.json());
    },
  });
}

/**
 * Read the backend's answer strictly. A part that is null stays null (not
 * counted yet); a part that is malformed fails the whole answer, so nothing
 * half-read is ever shown. The backend has already cleaned and capped
 * `topHoldings`; this is a defence-in-depth backstop, not a second pass of
 * leniency, so one bad entry still fails the whole answer.
 */
export function parsePoolStatsResponse(value: unknown): PoolStatsSnapshot {
  if (!isRecord(value)) throw invalid();
  const accounts = count(ownValue(value, 'accounts'));
  const deposits24h = count(ownValue(value, 'deposits24h'));
  const valueUsd = usdOrNull(ownValue(value, 'valueUsd'));
  const valueAsOf = isoStringOrNull(ownValue(value, 'valueAsOf'));
  const tokenCount = count(ownValue(value, 'tokenCount'));
  const topHoldingsValue = ownValue(value, 'topHoldings');
  let topHoldings: readonly PoolTokenValue[] | null = null;
  if (topHoldingsValue !== null) {
    if (!Array.isArray(topHoldingsValue)) throw invalid();
    const items = ownItems(topHoldingsValue);
    if (items.length > MAX_TOP_HOLDINGS) throw invalid();
    topHoldings = Object.freeze(items.map((item) => {
      if (!isRecord(item)) throw invalid();
      const symbol = ownValue(item, 'symbol');
      const usd = ownValue(item, 'usd');
      if (typeof symbol !== 'string' || symbol.length < 1 || symbol.length > MAX_SYMBOL_LENGTH) throw invalid();
      if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) throw invalid();
      return Object.freeze({ symbol, usd });
    }));
  }
  return Object.freeze({ accounts, deposits24h, valueUsd, topHoldings, valueAsOf, tokenCount });
}

/** What the monument draws: short figures, "…" in the World for any null. */
export function plazaStatsEvent(stats: PoolStatsSnapshot | null): ShellEvents['plaza:stats'] {
  const holdings = stats?.topHoldings;
  return Object.freeze({
    accounts: stats?.accounts == null ? null : formatPlazaCount(stats.accounts),
    deposits24h: stats?.deposits24h == null ? null : formatPlazaCount(stats.deposits24h),
    valueUsd: stats?.valueUsd == null ? null : formatCompactUsd(stats.valueUsd),
    topHoldings: holdings && holdings.length > 0 ? Object.freeze(holdings.map(formatMonumentHoldingLine)) : null,
  });
}

/** `2,932`. */
export function formatPlazaCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Compact USD, rounded (not truncated, unlike a token amount — a rounded
 * dollar figure reads naturally; a rounded-up token balance would not):
 * "$1.18M", "$453K", "$198K", "$11K", "$42", "$0".
 */
export function formatCompactUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0';
  for (const [power, suffix] of [[12, 'T'], [9, 'B'], [6, 'M'], [3, 'K']] as const) {
    const unit = 10 ** power;
    if (usd >= unit) {
      const scaled = usd / unit;
      const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      return `$${trimTrailingZeros(scaled.toFixed(decimals))}${suffix}`;
    }
  }
  return usd >= 1 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`;
}

/** The exact figure, for small print or a hover title: "$1,177,415". */
export function formatExactUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return '$0';
  return `$${Math.round(usd).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/** The panel's list line: "xSTRK $453K". */
export function formatHoldingLine(holding: PoolTokenValue): string {
  return `${holding.symbol} ${formatCompactUsd(holding.usd)}`;
}

/** The monument's cycling line: "xSTRK · $453K". */
export function formatMonumentHoldingLine(holding: PoolTokenValue): string {
  return `${holding.symbol} · ${formatCompactUsd(holding.usd)}`;
}

function trimTrailingZeros(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

function usdOrNull(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw invalid();
  return value;
}

function isoStringOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) throw invalid();
  return value;
}

function count(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_COUNT) throw invalid();
  return value;
}

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownValue(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !('value' in descriptor)) throw invalid();
  return descriptor.value;
}

function ownItems(array: readonly unknown[]): unknown[] {
  const length = Object.getOwnPropertyDescriptor(array, 'length');
  if (!length || !('value' in length) || !Number.isSafeInteger(length.value)) throw invalid();
  const items: unknown[] = [];
  for (let index = 0; index < (length.value as number); index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
    if (!descriptor || !('value' in descriptor)) throw invalid();
    items.push(descriptor.value);
  }
  return items;
}

function invalid(): Error {
  return new Error('The pool stats response is malformed.');
}
