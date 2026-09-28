import type { Address } from '@strkworld/privacy';
import { sameAddress } from '../../format.js';

/** avnu's token tags, as its public token API names them (D-067). */
export type AvnuTag = 'Unknown' | 'Verified' | 'Community' | 'Unruggable' | 'AVNU';

/** Display metadata only. The wallet policy remains the route authority (D-042). */
export interface ExchangeAsset {
  readonly symbol: string;
  readonly decimals: number;
  readonly token: Address;
  /** Degen floor only (D-067): the token's name, as listed. */
  readonly name?: string;
  /** Degen floor only (D-067): avnu's tags for the token, shown as chips. */
  readonly tags?: readonly AvnuTag[];
  /**
   * Degen floor only (D-067): `false` marks a listed token this build cannot
   * swap, which is shown as display only. Absent means swappable, as every
   * ground-floor asset is; the wallet policy still decides at prepare.
   */
  readonly swappable?: boolean;
}

/** Whether a listed asset may be chosen for a swap in this build. */
export function isSwappable(asset: ExchangeAsset): boolean {
  return asset.swappable !== false;
}

/**
 * Where a floor's listed assets came from: the ground floor's fixed six
 * (D-042), or the degen floor's list (D-067) from the backend's live copy of
 * avnu's list, its curated core alone while avnu is unreachable, or the demo.
 */
export type ExchangeCatalogOrigin = 'fixed' | 'live' | 'curated' | 'demo';

/** A floor whose listed assets load when it opens (the degen floor, D-067). */
export interface ExchangeCatalogPort {
  load(signal?: AbortSignal): Promise<{
    readonly origin: Exclude<ExchangeCatalogOrigin, 'fixed'>;
    readonly assets: readonly ExchangeAsset[];
  }>;
}

export const EXCHANGE_CATALOG: readonly ExchangeAsset[] = Object.freeze([
  { symbol: 'STRK', decimals: 18, token: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d' },
  { symbol: 'ETH', decimals: 18, token: '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7' },
  { symbol: 'USDC', decimals: 6, token: '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb' },
  { symbol: 'USDT', decimals: 6, token: '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8' },
  { symbol: 'WBTC', decimals: 8, token: '0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac' },
  { symbol: 'strkBTC', decimals: 8, token: '0x0787150e306e6eae6e3f79dea881770e8bbff2c1b8eb490f969669ee945b3135' },
].map((asset) => Object.freeze(asset)));

export function catalogAsset(token: Address): ExchangeAsset | undefined {
  return EXCHANGE_CATALOG.find((asset) => sameAddress(asset.token, token));
}

/** Reject malformed authored data before it can be presented as product truth. */
export function validateExchangeCatalog(catalog: readonly ExchangeAsset[] = EXCHANGE_CATALOG): void {
  if (catalog.length !== 6) throw new Error('Exchange catalog must contain six assets');
  const symbols = new Set<string>();
  const tokens = new Set<string>();
  for (const asset of catalog) {
    if (!asset.symbol || !Number.isInteger(asset.decimals) || asset.decimals < 0) {
      throw new Error('Exchange catalog has invalid display metadata');
    }
    const token = BigInt(asset.token).toString(16);
    if (symbols.has(asset.symbol) || tokens.has(token)) throw new Error('Exchange catalog contains a duplicate asset');
    symbols.add(asset.symbol);
    tokens.add(token);
  }
}

validateExchangeCatalog();
