import type { Address, WalletRoutePolicy } from '@strkworld/privacy';
import { looksLikeAddress, sameAddress } from '../../format.js';
import {
  EXCHANGE_CATALOG,
  type AvnuTag,
  type ExchangeAsset,
  type ExchangeCatalogOrigin,
  type ExchangeCatalogPort,
} from './catalog.js';

/**
 * The Exchange's degen floor catalog (D-067), as the Shell shows it.
 *
 * Presentation data. What a degen swap may use is decided elsewhere, twice:
 * the backend admits only its curated core and its own filtered copy of avnu's
 * live list, and this build's wallet policy admits only the swap tokens it
 * names. This module lists what the backend (or the demo) says is listed and
 * marks every token this build cannot swap as display only.
 */

export type DegenCatalogOrigin = Exclude<ExchangeCatalogOrigin, 'fixed'>;

export interface DegenListing {
  readonly token: Address;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly tags: readonly AvnuTag[];
  /** In the backend's pinned curated core, rather than from avnu's live list. */
  readonly curated: boolean;
  /** Demo only: `false` for a listed token the demo seam has no demo rate for. */
  readonly quotable?: boolean;
}

export interface DegenCatalogSnapshot {
  readonly origin: DegenCatalogOrigin;
  readonly listings: readonly DegenListing[];
}

export interface DegenCatalogSource {
  load(signal?: AbortSignal): Promise<DegenCatalogSnapshot>;
}

/** The backend route, under the same-origin `/api` prefix the edge strips. */
export const DEGEN_TOKENS_PATH = '/v1/degen/tokens';

const AVNU_TAGS: readonly AvnuTag[] = Object.freeze(['Unknown', 'Verified', 'Community', 'Unruggable', 'AVNU']);
const MAX_LISTINGS = 128;
const MAX_SYMBOL_LENGTH = 16;
const MAX_NAME_LENGTH = 64;
const MAX_DECIMALS = 36;
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

/**
 * STRK, the pool's money (D-013), is the degen floor's base asset: listed
 * first whatever the backend's list holds, so a player can always trade into
 * and out of the degen tokens, even while avnu is unreachable.
 */
export const DEGEN_BASE_ASSET: ExchangeAsset = Object.freeze({ ...strkAsset(), name: 'Starknet' });

function strkAsset(): ExchangeAsset {
  const strk = EXCHANGE_CATALOG.find((asset) => asset.symbol === 'STRK');
  if (!strk) throw new Error('The Exchange catalog has no STRK for the degen floor to trade against.');
  return strk;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The production source: one same-origin GET to the backend, which carries
 * nothing (no body, no query) and so cannot choose or add a token. The backend
 * fetches avnu itself, so avnu never sees a player's IP.
 */
export function createBackendDegenCatalog(options: { baseUrl: string; fetch?: FetchLike }): DegenCatalogSource {
  const { baseUrl } = options;
  if (typeof baseUrl !== 'string' || !baseUrl.startsWith('/') || baseUrl.startsWith('//')) {
    throw new Error('The degen list must be read from the same-origin backend path.');
  }
  const injected = options.fetch;
  const fetcher: FetchLike = injected
    ? (input, init) => Reflect.apply(injected, undefined, [input, init]) as Promise<Response>
    : (input, init) => globalThis.fetch(input, init);
  const url = `${baseUrl.replace(/\/$/, '')}${DEGEN_TOKENS_PATH}`;
  return Object.freeze({
    async load(signal?: AbortSignal): Promise<DegenCatalogSnapshot> {
      const response = await fetcher(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
        referrerPolicy: 'no-referrer',
        signal,
      });
      if (!response.ok) throw new Error('The degen list is unavailable.');
      return parseDegenCatalogResponse(await response.json());
    },
  });
}

/**
 * Read the backend's response strictly. Anything malformed fails the whole
 * list, so the counter says the list is unavailable rather than showing a
 * partial one. Only the six fields below are read; nothing else (a logo URL,
 * say) is ever rendered.
 */
export function parseDegenCatalogResponse(value: unknown): DegenCatalogSnapshot {
  if (!isRecord(value)) throw invalid();
  const source = ownValue(value, 'source');
  const tokens = ownValue(value, 'tokens');
  if ((source !== 'live' && source !== 'curated') || !Array.isArray(tokens)) throw invalid();
  const items = ownItems(tokens);
  if (items.length === 0 || items.length > MAX_LISTINGS) throw invalid();
  const listings = items.map(parseListing);
  const seen = new Set<bigint>();
  for (const listing of listings) {
    const key = BigInt(listing.token);
    if (seen.has(key)) throw invalid();
    seen.add(key);
  }
  return Object.freeze({ origin: source, listings: Object.freeze(listings) });
}

/**
 * Whether this build's wallet policy lets a swap use a token. No policy (the
 * demo, tests) restricts nothing beyond the register, exactly as `routeDoor`
 * treats it. Production enables swap only with its own switch (D-084): its
 * static list, plus, with the degen switch on, every token the backend's list
 * carries, which the backend's quote route vets. Off, every degen token is
 * display only, and the station is locked anyway.
 */
export function policyAdmitsSwapToken(policy: WalletRoutePolicy | null, token: Address): boolean {
  if (!policy) return true;
  try {
    return policy.enabledRoutes.includes('swap')
      && (policy.swap?.degen === true || policy.allowedTokens.swap.some((allowed) => sameAddress(allowed, token)));
  } catch {
    return false;
  }
}

/**
 * The degen floor's assets: STRK first, then the listed tokens in the
 * backend's order (curated core, then live by volume). A listing is swappable
 * only if this build admits it and, in the demo, the demo seam can quote it.
 * A token repeated by address, or whose ticker an earlier asset already uses,
 * is dropped: a picker cannot tell two tokens with one ticker apart, and the
 * earlier entry is the more trusted one.
 */
export function degenExchangeAssets(
  snapshot: DegenCatalogSnapshot,
  admits: (token: Address) => boolean,
): readonly ExchangeAsset[] {
  const assets: ExchangeAsset[] = [];
  const tickers = new Set<string>();
  const add = (asset: ExchangeAsset) => {
    const ticker = normalizeTicker(asset.symbol);
    if (ticker === '' || tickers.has(ticker) || assets.some((known) => sameAddress(known.token, asset.token))) return;
    tickers.add(ticker);
    assets.push(Object.freeze({ ...asset, tags: Object.freeze([...(asset.tags ?? [])]) }));
  };
  const baseListing = snapshot.listings.find((listing) => sameAddress(listing.token, DEGEN_BASE_ASSET.token));
  add({
    ...DEGEN_BASE_ASSET,
    tags: baseListing?.tags ?? [],
    swappable: baseListing?.quotable !== false && safeAdmits(admits, DEGEN_BASE_ASSET.token),
  });
  for (const listing of snapshot.listings) {
    add({
      symbol: listing.symbol,
      name: listing.name,
      decimals: listing.decimals,
      token: listing.token,
      tags: listing.tags,
      swappable: listing.quotable !== false && safeAdmits(admits, listing.token),
    });
  }
  return Object.freeze(assets);
}

/** The degen floor's catalog port: the source's list, marked for this build. */
export function degenExchangeCatalog(
  source: DegenCatalogSource | null,
  admits: (token: Address) => boolean,
): ExchangeCatalogPort {
  return Object.freeze({
    async load(signal?: AbortSignal) {
      if (!source) throw new Error('This build has no degen list.');
      const snapshot = await source.load(signal);
      return Object.freeze({ origin: snapshot.origin, assets: degenExchangeAssets(snapshot, admits) });
    },
  });
}

/** Tickers compare by letters and digits, case-folded, as the backend compares them. */
export function normalizeTicker(symbol: string): string {
  return symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function safeAdmits(admits: (token: Address) => boolean, token: Address): boolean {
  try {
    return admits(token) === true;
  } catch {
    return false;
  }
}

function parseListing(entry: unknown): DegenListing {
  if (!isRecord(entry)) throw invalid();
  const token = ownValue(entry, 'address');
  const symbol = ownValue(entry, 'symbol');
  const name = ownValue(entry, 'name');
  const decimals = ownValue(entry, 'decimals');
  const curated = ownValue(entry, 'curated');
  const tags = parseTags(ownValue(entry, 'tags'));
  if (
    typeof token !== 'string' || !isNonzeroFelt(token) ||
    typeof symbol !== 'string' || !isDisplayText(symbol, MAX_SYMBOL_LENGTH) || normalizeTicker(symbol) === '' ||
    typeof name !== 'string' || !isDisplayText(name, MAX_NAME_LENGTH) ||
    typeof decimals !== 'number' || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS ||
    typeof curated !== 'boolean'
  ) {
    throw invalid();
  }
  return Object.freeze({ token, symbol, name, decimals, tags, curated });
}

function parseTags(value: unknown): readonly AvnuTag[] {
  if (!Array.isArray(value)) throw invalid();
  const items = ownItems(value);
  if (items.length > AVNU_TAGS.length) throw invalid();
  const tags = new Set<AvnuTag>();
  for (const tag of items) {
    if (typeof tag !== 'string' || !(AVNU_TAGS as readonly string[]).includes(tag) || tags.has(tag as AvnuTag)) {
      throw invalid();
    }
    tags.add(tag as AvnuTag);
  }
  return Object.freeze(AVNU_TAGS.filter((tag) => tags.has(tag)));
}

function isNonzeroFelt(value: string): boolean {
  if (!looksLikeAddress(value) || value !== value.trim()) return false;
  const parsed = BigInt(value);
  return parsed > 0n && parsed < STARK_FIELD_PRIME;
}

/** Printable ASCII with no edge spaces, as the backend requires of avnu's text. */
function isDisplayText(value: string, maxLength: number): boolean {
  return value.length <= maxLength && /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value);
}

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownValue(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** An array's items by own index, so a hole or an accessor cannot slip past as something else. */
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
  return new Error('The degen list response is malformed.');
}
