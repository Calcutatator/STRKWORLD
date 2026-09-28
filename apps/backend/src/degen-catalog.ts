import type {
  AvnuTokenTag,
  DegenCatalogSnapshot,
  DegenConfig,
  DegenTag,
  DegenToken,
} from './types.js';
import { isFelt } from './validation.js';

/**
 * The degen floor's token catalog (D-067), without any I/O: the pinned
 * curated core, the tickers no live token may take, and the filter applied to
 * avnu's live list. `avnu-degen-catalog.ts` fetches and caches that list.
 *
 * This is the swap route's only admission source besides
 * `BACKEND_ROUTE_SWAP_ALLOWED_TOKENS`. Addresses come from the curated core
 * below or from avnu's API, never from a request, and the pool itself accepts
 * any ERC-20, so this filter is the gate.
 */

/** The tags D-067 admits. `Unknown` is never one of them. */
export const DEGEN_TAGS: readonly DegenTag[] = Object.freeze(['Verified', 'Community', 'Unruggable', 'AVNU']);

/** avnu's own tag order (its OpenAPI enum), so every token's tags read the same way. */
const AVNU_TAG_ORDER: readonly AvnuTokenTag[] = Object.freeze([
  'Unknown',
  'Verified',
  'Community',
  'Unruggable',
  'AVNU',
]);

export const DEGEN_MIN_CACHE_TTL_MS = 60_000;
export const DEGEN_MAX_CACHE_TTL_MS = 86_400_000;
export const DEGEN_MAX_MIN_DAILY_VOLUME_USD = 1_000_000_000;

/** The most live tokens one snapshot lists after filtering. The curated core is always extra. */
export const DEGEN_MAX_LIVE_TOKENS = 64;

const MAX_SYMBOL_LENGTH = 16;
const MAX_NAME_LENGTH = 64;
const MAX_DECIMALS = 36;

/**
 * The curated core (D-067): always listed, and always admitted while degen
 * mode is on. Addresses, decimals and tags were read from avnu's public token
 * API (`GET https://starknet.api.avnu.fi/v1/starknet/tokens`) on 2026-09-28;
 * `symbol()`, `name()` and `decimals()` were then re-read from each mainnet
 * contract at block 15,566,935 through the Cartridge public RPC and match.
 * DREAMS is `dreams` on-chain and on avnu; tickers compare case-insensitively.
 *
 * The tags are avnu's as of that date. A live snapshot shows avnu's current
 * tags for a curated token whenever avnu's list includes it.
 */
export const DEGEN_CURATED_CORE: readonly DegenToken[] = freezeTokens([
  {
    symbol: 'LORDS',
    name: 'Lords',
    address: '0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49',
    decimals: 18,
    tags: ['Verified', 'AVNU'],
    curated: true,
  },
  {
    symbol: 'DREAMS',
    name: 'Daydreams',
    address: '0x04fcaf2a7b4a072fe57c59beee807322d34ed65000d78611c909a46fead07fb1',
    decimals: 6,
    tags: ['Verified', 'Community'],
    curated: true,
  },
  {
    symbol: 'SLAY',
    name: 'Brother Eli',
    address: '0x02ab526354a39e7f5d272f327fa94e757df3688188d4a92c6dc3623ab79894e2',
    decimals: 18,
    tags: ['Verified', 'Community', 'Unruggable'],
    curated: true,
  },
  {
    symbol: 'BROTHER',
    name: 'STARKNET BROTHER',
    address: '0x03b405a98c9e795d427fe82cdeeeed803f221b52471e3a757574a2b4180793ee',
    decimals: 18,
    tags: ['Verified', 'Community', 'Unruggable'],
    curated: true,
  },
  {
    symbol: 'tBTC',
    name: 'Starknet tBTC',
    address: '0x04daa17763b286d1e59b97c283c0b8c949994c361e426a28f743c67bdfe9a32f',
    decimals: 18,
    tags: ['Verified', 'Community', 'AVNU'],
    curated: true,
  },
  {
    symbol: 'CASH',
    name: 'Cash',
    address: '0x0498edfaf50ca5855666a700c25dd629d577eb9afccdf3b5977aec79aee55ada',
    decimals: 18,
    tags: ['Verified', 'Community'],
    curated: true,
  },
  {
    symbol: 'DOG',
    name: 'DOG GO TO THE MOON',
    address: '0x040e81cfeb176bfdbc5047bbc55eb471cfab20a6b221f38d8fda134e1bfffca4',
    decimals: 5,
    tags: ['Verified', 'Community', 'AVNU'],
    curated: true,
  },
]);

/**
 * D-042's six ground-floor assets, pinned here independently of the browser
 * (as `endur.ts` pins Endur) for one purpose: no live token may take their
 * tickers either. This does not add them to the degen list.
 */
const GROUND_FLOOR_TICKERS: readonly { symbol: string; address: string }[] = Object.freeze([
  { symbol: 'STRK', address: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d' },
  { symbol: 'ETH', address: '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7' },
  { symbol: 'USDC', address: '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb' },
  { symbol: 'USDT', address: '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8' },
  { symbol: 'WBTC', address: '0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac' },
  { symbol: 'strkBTC', address: '0x0787150e306e6eae6e3f79dea881770e8bbff2c1b8eb490f969669ee945b3135' },
].map((entry) => Object.freeze(entry)));

/** Ticker → the one address allowed to use it. */
const RESERVED_TICKERS: ReadonlyMap<string, bigint> = new Map(
  [...DEGEN_CURATED_CORE, ...GROUND_FLOOR_TICKERS].map((token) => [
    normalizeTicker(token.symbol),
    BigInt(token.address),
  ]),
);

const CURATED_ADDRESSES: ReadonlyMap<bigint, DegenToken> = new Map(
  DEGEN_CURATED_CORE.map((token) => [BigInt(token.address), token]),
);

/**
 * How two tickers are compared: letters and digits only, case-folded. `lords`,
 * `LORDS ` and `L.O.R.D.S` are all LORDS. Live symbols are printable ASCII
 * before they get here, so a look-alike from another script never arrives.
 */
export function normalizeTicker(symbol: string): string {
  return symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export interface LiveFilterResult {
  /** Live tokens that passed, in avnu's order (highest routed volume first). */
  readonly live: readonly DegenToken[];
  /** avnu's current tags for curated tokens its list included. */
  readonly curatedTags: ReadonlyMap<bigint, readonly AvnuTokenTag[]>;
}

/**
 * Filter avnu's live list for the degen floor (D-067).
 *
 * A live token is listed only if it carries at least one configured tag, its
 * `lastDailyVolumeUsd` meets the floor, its ticker is no curated or
 * ground-floor ticker at a different address (an impostor), no other live
 * token shares its ticker (ambiguous, so neither is listed), and every field
 * is well formed: a nonzero felt address, bounded decimals, printable-ASCII
 * symbol and name, and only tags avnu defines. A curated token found in the
 * list is never added twice; its current tags are returned instead.
 */
export function filterLiveTokens(
  raw: readonly unknown[],
  config: Pick<DegenConfig, 'tags' | 'minDailyVolumeUsd'>,
): LiveFilterResult {
  const curatedTags = new Map<bigint, readonly AvnuTokenTag[]>();
  const seen = new Set<bigint>();
  const passed: Array<{ ticker: string; token: DegenToken }> = [];
  for (const entry of raw) {
    const candidate = readAvnuToken(entry);
    if (!candidate) continue;
    const key = BigInt(candidate.address);
    // avnu lists highest volume first; a repeated address keeps its first entry.
    if (seen.has(key)) continue;
    seen.add(key);
    const curated = CURATED_ADDRESSES.get(key);
    if (curated) {
      // Pinned metadata wins. avnu's tags are taken only while its entry still
      // agrees with the reviewed decimals.
      if (candidate.decimals === curated.decimals) curatedTags.set(key, candidate.tags);
      continue;
    }
    if (!candidate.tags.some((tag) => (config.tags as readonly string[]).includes(tag))) continue;
    if (!(candidate.volume >= config.minDailyVolumeUsd)) continue;
    const ticker = normalizeTicker(candidate.symbol);
    if (ticker === '') continue;
    const owner = RESERVED_TICKERS.get(ticker);
    if (owner !== undefined && owner !== key) continue;
    passed.push({
      ticker,
      token: Object.freeze({
        address: candidate.address,
        symbol: candidate.symbol,
        name: candidate.name,
        decimals: candidate.decimals,
        tags: candidate.tags,
        curated: false,
      }),
    });
  }
  const perTicker = new Map<string, number>();
  for (const { ticker } of passed) perTicker.set(ticker, (perTicker.get(ticker) ?? 0) + 1);
  const live = passed
    .filter(({ ticker }) => perTicker.get(ticker) === 1)
    .slice(0, DEGEN_MAX_LIVE_TOKENS)
    .map(({ token }) => token);
  return { live: Object.freeze(live), curatedTags };
}

/** The curated core, refreshed with avnu's current tags where known, then the live list. */
export function degenSnapshot(
  source: DegenCatalogSnapshot['source'],
  filtered?: LiveFilterResult,
): DegenCatalogSnapshot {
  const curated = DEGEN_CURATED_CORE.map((token) => {
    const tags = filtered?.curatedTags.get(BigInt(token.address));
    return tags ? Object.freeze({ ...token, tags }) : token;
  });
  return Object.freeze({
    source,
    tokens: Object.freeze([...curated, ...(filtered?.live ?? [])]),
  });
}

/** What the degen list says while avnu cannot be reached: the curated core alone. */
export const CURATED_ONLY_SNAPSHOT: DegenCatalogSnapshot = degenSnapshot('curated');

/** The response shape: explicit fields only, so nothing else avnu sent (a logo URL, say) reaches a player. */
export function publicDegenToken(token: DegenToken): {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  tags: AvnuTokenTag[];
  curated: boolean;
} {
  return {
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    tags: [...token.tags],
    curated: token.curated,
  };
}

/** Fail closed on a malformed configuration, however it was constructed. */
export function validateDegenConfig(config: DegenConfig): void {
  const tags: readonly unknown[] = Array.isArray(config.tags) ? config.tags : [];
  if (
    typeof config.enabled !== 'boolean' ||
    tags.length === 0 ||
    tags.some((tag) => !(DEGEN_TAGS as readonly unknown[]).includes(tag)) ||
    new Set(tags).size !== tags.length ||
    !Number.isSafeInteger(config.minDailyVolumeUsd) ||
    config.minDailyVolumeUsd < 1 ||
    config.minDailyVolumeUsd > DEGEN_MAX_MIN_DAILY_VOLUME_USD ||
    !Number.isSafeInteger(config.cacheTtlMs) ||
    config.cacheTtlMs < DEGEN_MIN_CACHE_TTL_MS ||
    config.cacheTtlMs > DEGEN_MAX_CACHE_TTL_MS
  ) {
    throw new Error('Backend degen catalog configuration is invalid.');
  }
}

interface AvnuTokenCandidate {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  volume: number;
  tags: readonly AvnuTokenTag[];
}

/** One entry of avnu's list, read from own data properties only; anything malformed is dropped. */
function readAvnuToken(entry: unknown): AvnuTokenCandidate | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const address = ownValue(entry, 'address');
  const symbol = ownValue(entry, 'symbol');
  const name = ownValue(entry, 'name');
  const decimals = ownValue(entry, 'decimals');
  const volume = ownValue(entry, 'lastDailyVolumeUsd');
  const tags = readTags(ownValue(entry, 'tags'));
  if (
    typeof address !== 'string' ||
    !isFelt(address) ||
    BigInt(address) === 0n ||
    typeof symbol !== 'string' ||
    !isDisplayText(symbol, MAX_SYMBOL_LENGTH) ||
    typeof name !== 'string' ||
    !isDisplayText(name, MAX_NAME_LENGTH) ||
    typeof decimals !== 'number' ||
    !Number.isSafeInteger(decimals) ||
    decimals < 0 ||
    decimals > MAX_DECIMALS ||
    typeof volume !== 'number' ||
    !Number.isFinite(volume) ||
    volume < 0 ||
    tags === null
  ) {
    return null;
  }
  return { address, symbol, name, decimals, volume, tags };
}

/** Only avnu's defined tags, each once, in avnu's order. An undefined tag drops the token. */
function readTags(value: unknown): readonly AvnuTokenTag[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > AVNU_TAG_ORDER.length) return null;
  const tags = new Set<AvnuTokenTag>();
  for (let index = 0; index < value.length; index += 1) {
    const tag = ownValue(value, String(index));
    if (typeof tag !== 'string' || !(AVNU_TAG_ORDER as readonly string[]).includes(tag)) return null;
    if (tags.has(tag as AvnuTokenTag)) return null;
    tags.add(tag as AvnuTokenTag);
  }
  return Object.freeze(AVNU_TAG_ORDER.filter((tag) => tags.has(tag)));
}

/** Printable ASCII, no edge spaces, bounded: text that cannot imitate another script's letters. */
function isDisplayText(value: string, maxLength: number): boolean {
  return value.length <= maxLength && /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value);
}

function ownValue(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function freezeTokens(tokens: DegenToken[]): readonly DegenToken[] {
  return Object.freeze(tokens.map((token) => Object.freeze({ ...token, tags: Object.freeze([...token.tags]) })));
}
