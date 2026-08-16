import { createStore, type Store } from '@starknet-io/get-starknet-discovery';
import type { WalletWithStarknetFeatures } from '@starknet-io/get-starknet-wallet-standard/features';
import { walletV6 } from 'starknet';
import type { SupportedVersionsReader } from './types.js';

/** Dynamic wallet-standard discovery. Never a static connector registry. */
export function createWalletDiscovery(): Store {
  return createStore();
}

/** Bind capability detection to the connected wallet-standard provider. */
export function createSupportedVersionsReader(
  wallet: WalletWithStarknetFeatures,
): SupportedVersionsReader {
  return async (signal) => {
    if (signal?.aborted) throw new DOMException('Operation cancelled.', 'AbortError');
    // The exact direct pins still contain two structurally equivalent v6 type
    // copies. Keep that packaging mismatch at this one boundary.
    const versions = await walletV6.supportedWalletApi(
      wallet as Parameters<typeof walletV6.supportedWalletApi>[0],
    );
    if (signal?.aborted) throw new DOMException('Operation cancelled.', 'AbortError');
    return versions;
  };
}
