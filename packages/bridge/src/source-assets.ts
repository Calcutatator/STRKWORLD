import type { TokenResponse } from '@defuse-protocol/one-click-sdk-typescript';
import type { SourceAsset, SourceChain } from './types.js';

export const STRK_ON_STARKNET_ASSET_ID = 'nep141:starknet.omft.near';

const CURATED: readonly SourceAsset[] = [
  ['nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', 'USDC', 'ethereum', 6],
  ['nep141:eth.omft.near', 'ETH', 'ethereum', 18],
  ['nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', 'USDC', 'base', 6],
  ['nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', 'USDC', 'arbitrum', 6],
  ['nep141:sol.omft.near', 'SOL', 'solana', 9],
  ['nep141:tron.omft.near', 'TRX', 'tron', 6],
].map(([assetId, symbol, chainName, decimals]) => ({
  assetId: assetId as string,
  symbol: symbol as string,
  chainName: chainName as SourceChain,
  decimals: decimals as number,
  depositMode: 'manual' as const,
  availability: 'fallback' as const,
}));

const CHAIN_MAP: Partial<Record<string, SourceChain>> = {
  near: 'near',
  eth: 'ethereum',
  base: 'base',
  arb: 'arbitrum',
  pol: 'polygon',
  bsc: 'bsc',
  abs: 'abstract',
  gnosis: 'gnosis',
  bera: 'berachain',
  monad: 'monad',
  xlayer: 'xlayer',
  plasma: 'plasma',
  op: 'optimism',
  avax: 'avalanche',
  adi: 'adi',
  scroll: 'scroll',
  hypercore: 'hypercore',
  sol: 'solana',
  fogo: 'fogo',
  sui: 'sui',
  movement: 'movement',
  aptos: 'aptos',
  btc: 'bitcoin',
  bch: 'bitcoin-cash',
  ltc: 'litecoin',
  doge: 'dogecoin',
  dash: 'dash',
  zec: 'zcash',
  xrp: 'xrp',
  cardano: 'cardano',
  aleo: 'aleo',
  stellar: 'stellar',
  ton: 'ton',
  tron: 'tron',
};

export interface TokenRegistryClient {
  getTokens(): Promise<TokenResponse[]>;
}

/** Merge current route metadata over a known-safe picker fallback. */
export async function loadSourceAssets(client: TokenRegistryClient): Promise<SourceAsset[]> {
  const byId = new Map(CURATED.map((asset) => [asset.assetId, { ...asset }]));
  let live: TokenResponse[];
  try {
    live = await client.getTokens();
  } catch {
    return [...byId.values()];
  }
  if (!Array.isArray(live)) return [...byId.values()];

  for (const token of live) {
    if (!token || typeof token !== 'object' || Array.isArray(token)) continue;
    if (token.assetId === STRK_ON_STARKNET_ASSET_ID) continue;
    const chainName = CHAIN_MAP[String(token.blockchain)];
    if (
      !chainName ||
      !token.assetId ||
      !token.symbol ||
      !Number.isSafeInteger(token.decimals) ||
      token.decimals < 0 ||
      token.decimals > 36
    ) continue;
    const fallback = byId.get(token.assetId);
    byId.set(token.assetId, {
      assetId: token.assetId,
      symbol: token.symbol,
      chainName,
      decimals: token.decimals,
      depositMode: fallback?.depositMode ?? 'manual',
      availability: 'live',
    });
  }
  return [...byId.values()];
}
