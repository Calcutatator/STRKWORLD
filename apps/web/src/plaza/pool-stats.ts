import type { ShellEvents } from '@strkworld/shared';
import type { Address, WalletRoutePolicy } from '@strkworld/privacy';
import { EXCHANGE_CATALOG, catalogAsset } from '../panels/exchange/catalog.js';
import { formatTokenAmountExact, looksLikeAddress, sameAddress } from '../format.js';

/**
 * The Privacy Plaza's pool stats (D-076), as the Shell reads and shows them.
 *
 * Public, pool-wide aggregates from the backend's cache: accounts registered,
 * deposits in the last day, and the pool's balance of each token. Nothing
 * here is about the player: the request carries only a version, and the
 * answer holds only counts and per-token totals. The World gets them
 * pre-formatted (`plaza:stats`), the way it gets the HUD balance.
 */

export interface PoolHolding {
  readonly token: Address;
  readonly amount: bigint;
}

export interface PoolStatsSnapshot {
  readonly accounts: number | null;
  readonly deposits24h: number | null;
  readonly held: readonly PoolHolding[] | null;
}

export interface PoolStatsSource {
  /** Demo figures, which every surface that shows them must label as such. */
  readonly demo: boolean;
  load(signal?: AbortSignal): Promise<PoolStatsSnapshot>;
}

/** A token the plaza can show, with its display metadata. */
export interface PlazaToken {
  readonly token: Address;
  readonly symbol: string;
  readonly decimals: number;
}

/** The backend route, under the same-origin `/api` prefix the edge strips. */
export const POOL_STATS_PATH = '/v1/rpc/pool-stats';

const MAX_HELD = 16;
const MAX_COUNT = 1_000_000_000_000;
const MAX_UINT256 = (1n << 256n) - 1n;

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
 * half-read is ever shown.
 */
export function parsePoolStatsResponse(value: unknown): PoolStatsSnapshot {
  if (!isRecord(value)) throw invalid();
  const accounts = count(ownValue(value, 'accounts'));
  const deposits24h = count(ownValue(value, 'deposits24h'));
  const heldValue = ownValue(value, 'held');
  let held: readonly PoolHolding[] | null = null;
  if (heldValue !== null) {
    if (!Array.isArray(heldValue)) throw invalid();
    const items = ownItems(heldValue);
    if (items.length > MAX_HELD) throw invalid();
    held = Object.freeze(items.map((item) => {
      if (!isRecord(item)) throw invalid();
      const token = ownValue(item, 'token');
      const amount = ownValue(item, 'amount');
      if (typeof token !== 'string' || !looksLikeAddress(token) || BigInt(token) === 0n) throw invalid();
      if (typeof amount !== 'string' || !/^(?:0|[1-9][0-9]{0,77})$/.test(amount)) throw invalid();
      const parsed = BigInt(amount);
      if (parsed > MAX_UINT256) throw invalid();
      return Object.freeze({ token: token as Address, amount: parsed });
    }));
  }
  return Object.freeze({ accounts, deposits24h, held });
}

/**
 * The tokens the plaza shows: this build's shield allowlist, in its order,
 * that the Exchange catalog describes (the shell's one token metadata
 * source, D-042). No policy (the demo, tests) restricts nothing, as
 * everywhere else: every catalog token.
 */
export function plazaTokens(policy: WalletRoutePolicy | null): readonly PlazaToken[] {
  let listed: readonly unknown[];
  try {
    const allowlist = policy === null ? EXCHANGE_CATALOG.map((asset) => asset.token) : policy.allowedTokens.shield;
    listed = Array.isArray(allowlist) ? [...allowlist] : [];
  } catch {
    return Object.freeze([]);
  }
  const tokens: PlazaToken[] = [];
  for (const token of listed) {
    if (typeof token !== 'string') continue;
    const asset = catalogAsset(token);
    if (!asset || tokens.some((entry) => sameAddress(entry.token, asset.token))) continue;
    tokens.push(Object.freeze({ token: asset.token, symbol: asset.symbol, decimals: asset.decimals }));
  }
  return Object.freeze(tokens);
}

/** One held line per shown token the answer covers, in the shown order. */
export function plazaHeldLines(
  held: readonly PoolHolding[] | null,
  tokens: readonly PlazaToken[],
  format: (amount: bigint, decimals: number) => string,
): readonly string[] | null {
  if (held === null) return null;
  const lines: string[] = [];
  for (const token of tokens) {
    const holding = held.find((entry) => sameAddress(entry.token, token.token));
    if (holding) lines.push(`${format(holding.amount, token.decimals)} ${token.symbol}`);
  }
  return lines.length > 0 ? Object.freeze(lines) : null;
}

/** What the monument draws: short figures, "…" in the World for any null. */
export function plazaStatsEvent(
  stats: PoolStatsSnapshot | null,
  tokens: readonly PlazaToken[],
): ShellEvents['plaza:stats'] {
  return Object.freeze({
    accounts: stats?.accounts == null ? null : formatPlazaCount(stats.accounts),
    deposits24h: stats?.deposits24h == null ? null : formatPlazaCount(stats.deposits24h),
    held: plazaHeldLines(stats?.held ?? null, tokens, formatCompactAmount),
  });
}

/** `2,932`. */
export function formatPlazaCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Three significant figures, truncated like every shortened amount here
 * (`format.ts`): `2.56M`, `200K`, `10.3K`, `18.9`, `0.359`.
 */
export function formatCompactAmount(amount: bigint, decimals: number): string {
  if (amount <= 0n) return '0';
  const [whole = '0', fraction = ''] = formatTokenAmountExact(amount, decimals).split('.');
  if (whole !== '0') {
    for (const [power, suffix] of [[12, 'T'], [9, 'B'], [6, 'M'], [3, 'K']] as const) {
      if (whole.length <= power) continue;
      const head = whole.slice(0, whole.length - power);
      const rest = whole.slice(whole.length - power);
      const tail = rest.slice(0, Math.max(0, 3 - head.length)).replace(/0+$/, '');
      return tail ? `${head}.${tail}${suffix}` : `${head}${suffix}`;
    }
    const tail = fraction.slice(0, Math.max(0, 3 - whole.length)).replace(/0+$/, '');
    return tail ? `${whole}.${tail}` : whole;
  }
  const lead = fraction.search(/[1-9]/);
  return lead < 0 ? '0' : `0.${fraction.slice(0, lead + 3).replace(/0+$/, '')}`;
}

/** The panel's fuller figure: `2,561,829.87`, `18.97`, `0.3593`. Truncated. */
export function formatPanelAmount(amount: bigint, decimals: number): string {
  if (amount <= 0n) return '0';
  const [whole = '0', fraction = ''] = formatTokenAmountExact(amount, decimals).split('.');
  if (whole !== '0') {
    const tail = fraction.slice(0, 2).replace(/0+$/, '');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return tail ? `${grouped}.${tail}` : grouped;
  }
  const lead = fraction.search(/[1-9]/);
  return lead < 0 ? '0' : `0.${fraction.slice(0, lead + 4).replace(/0+$/, '')}`;
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
