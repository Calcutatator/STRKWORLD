import { describe, expect, it } from 'vitest';
import { EXCHANGE_CATALOG, validateExchangeCatalog } from './catalog.js';

describe('the D-042 display catalog', () => {
  it('has the checked-in six mainnet assets in product order', () => {
    expect(EXCHANGE_CATALOG).toEqual([
      { symbol: 'STRK', decimals: 18, token: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d' },
      { symbol: 'ETH', decimals: 18, token: '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7' },
      { symbol: 'USDC', decimals: 6, token: '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb' },
      { symbol: 'USDT', decimals: 6, token: '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8' },
      { symbol: 'WBTC', decimals: 8, token: '0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac' },
      { symbol: 'strkBTC', decimals: 8, token: '0x0787150e306e6eae6e3f79dea881770e8bbff2c1b8eb490f969669ee945b3135' },
    ]);
  });

  it('reaches and rejects duplicate token and symbol validation', () => {
    const duplicateToken = EXCHANGE_CATALOG.map((asset, index) =>
      index === 5 ? { ...asset, symbol: 'OTHER', token: EXCHANGE_CATALOG[0]!.token } : asset,
    );
    const duplicateSymbol = EXCHANGE_CATALOG.map((asset, index) =>
      index === 5 ? { ...asset, symbol: EXCHANGE_CATALOG[0]!.symbol } : asset,
    );

    expect(() => validateExchangeCatalog(duplicateToken)).toThrow('duplicate asset');
    expect(() => validateExchangeCatalog(duplicateSymbol)).toThrow('duplicate asset');
  });
});
