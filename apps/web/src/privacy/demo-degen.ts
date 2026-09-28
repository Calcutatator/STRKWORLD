import type { Address } from '@strkworld/privacy';
import type {
  DegenCatalogSnapshot,
  DegenCatalogSource,
  DegenListing,
} from '../panels/exchange/degen-catalog.js';

/**
 * The demo's degen floor (D-067): a static list standing in for the backend's,
 * and the demo seam's rates for it. Loaded only through dynamic imports (the
 * degen catalog provider and `demo-operations.ts`), so none of it reaches a
 * production bundle's entry chunk, and the demo seam is refused in production
 * anyway.
 *
 * The list is the backend's pinned curated core, as avnu tagged it on
 * 2026-09-28 (`apps/backend/src/degen-catalog.ts`), plus two real tokens from
 * avnu's live list standing in for its live entries: EKUBO, which the demo can
 * quote, and SSTR, which it cannot, so the demo shows a display-only token.
 */

const STRK: Address = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const LORDS: Address = '0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49';
const DREAMS: Address = '0x04fcaf2a7b4a072fe57c59beee807322d34ed65000d78611c909a46fead07fb1';
const SLAY: Address = '0x02ab526354a39e7f5d272f327fa94e757df3688188d4a92c6dc3623ab79894e2';
const BROTHER: Address = '0x03b405a98c9e795d427fe82cdeeeed803f221b52471e3a757574a2b4180793ee';
const TBTC: Address = '0x04daa17763b286d1e59b97c283c0b8c949994c361e426a28f743c67bdfe9a32f';
const CASH: Address = '0x0498edfaf50ca5855666a700c25dd629d577eb9afccdf3b5977aec79aee55ada';
const DOG: Address = '0x040e81cfeb176bfdbc5047bbc55eb471cfab20a6b221f38d8fda134e1bfffca4';
const EKUBO: Address = '0x075afe6402ad5a5c20dd25e10ec3b3986acaa647b77e4ae24b0cbc9a54a27a87';
const SSTR: Address = '0x0102d5e124c51b936ee87302e0f938165aec96fb6c2027ae7f3a5ed46c77573b';

/**
 * DEMO RATES, not prices: base units of each token the demo seam counts as
 * worth one STRK. Round powers of ten on purpose, so nobody mistakes one for a
 * market rate. The fake quotes a swap between two of these tokens from them
 * alone; the Exchange says on screen that they are demo rates.
 */
export const DEMO_DEGEN_RATES: Readonly<Record<Address, bigint>> = Object.freeze({
  [STRK]: 10n ** 18n, // 1 STRK
  [LORDS]: 10n ** 19n, // 10 LORDS (18 decimals)
  [DREAMS]: 10n ** 8n, // 100 DREAMS (6 decimals)
  [SLAY]: 10n ** 21n, // 1,000 SLAY (18 decimals)
  [BROTHER]: 10n ** 22n, // 10,000 BROTHER (18 decimals)
  [TBTC]: 10n ** 13n, // 0.00001 tBTC (18 decimals)
  [CASH]: 10n ** 17n, // 0.1 CASH (18 decimals)
  [DOG]: 10n ** 8n, // 1,000 DOG (5 decimals)
  [EKUBO]: 10n ** 17n, // 0.1 EKUBO (18 decimals)
});

/** The demo quote's fixed slippage and expiry, the same as the ground floor's demo. */
export const DEMO_DEGEN_SLIPPAGE_BPS = 50;
export const DEMO_DEGEN_EXPIRES_AT = 4_102_444_800_000;

const LISTINGS: readonly Omit<DegenListing, 'quotable'>[] = [
  { token: LORDS, symbol: 'LORDS', name: 'Lords', decimals: 18, tags: ['Verified', 'AVNU'], curated: true },
  { token: DREAMS, symbol: 'DREAMS', name: 'Daydreams', decimals: 6, tags: ['Verified', 'Community'], curated: true },
  { token: SLAY, symbol: 'SLAY', name: 'Brother Eli', decimals: 18, tags: ['Verified', 'Community', 'Unruggable'], curated: true },
  { token: BROTHER, symbol: 'BROTHER', name: 'STARKNET BROTHER', decimals: 18, tags: ['Verified', 'Community', 'Unruggable'], curated: true },
  { token: TBTC, symbol: 'tBTC', name: 'Starknet tBTC', decimals: 18, tags: ['Verified', 'Community', 'AVNU'], curated: true },
  { token: CASH, symbol: 'CASH', name: 'Cash', decimals: 18, tags: ['Verified', 'Community'], curated: true },
  { token: DOG, symbol: 'DOG', name: 'DOG GO TO THE MOON', decimals: 5, tags: ['Verified', 'Community', 'AVNU'], curated: true },
  // Demo "live" extras.
  { token: EKUBO, symbol: 'EKUBO', name: 'Ekubo Protocol', decimals: 18, tags: ['Verified', 'AVNU'], curated: false },
  { token: SSTR, symbol: 'SSTR', name: 'SISTER', decimals: 18, tags: ['Verified', 'Community', 'Unruggable'], curated: false },
];

function rated(token: Address): boolean {
  return Object.keys(DEMO_DEGEN_RATES).some((candidate) => BigInt(candidate) === BigInt(token));
}

const DEMO_SNAPSHOT: DegenCatalogSnapshot = Object.freeze({
  origin: 'demo',
  listings: Object.freeze(LISTINGS.map((listing) => Object.freeze({
    ...listing,
    tags: Object.freeze([...listing.tags]),
    quotable: rated(listing.token),
  }))),
});

/** The demo's list: no network, no clock, the same answer every time. */
export const DEMO_DEGEN_CATALOG: DegenCatalogSource = Object.freeze({
  async load(signal?: AbortSignal): Promise<DegenCatalogSnapshot> {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    return DEMO_SNAPSHOT;
  },
});
