import { createStore, type Store } from '@starknet-io/get-starknet-discovery';
import type { WalletWithStarknetFeatures } from '@starknet-io/get-starknet-wallet-standard/features';
import { walletV6 } from 'starknet';
import type { SupportedVersionsReader } from './types.js';

/**
 * Dynamic wallet-standard discovery. Never a static connector registry.
 *
 * D-108: no EIP-1193 adapters. get-starknet's only default adapter wraps
 * MetaMask (EIP-6963 `io.metamask`) as a virtual Starknet wallet whose first
 * request downloads and runs the Starknet Snap's remote bundle from
 * snaps.consensys.io, and every request after that can raise a MetaMask
 * window. The Snap has no STRK20 methods, so the adapter is never built.
 * Wallet Standard registration and injected `window.starknet_*` globals are
 * unchanged; the session's denylist (unsupported-wallets.ts) catches MetaMask
 * arriving any other way.
 */
export function createWalletDiscovery(): Store {
  return createStore({ eip1193Adapters: [] });
}

/** Bind capability detection to the connected wallet-standard provider. */
export function createSupportedVersionsReader(
  wallet: WalletWithStarknetFeatures,
): SupportedVersionsReader {
  return async (signal) => {
    if (isAborted(signal)) throw new DOMException('Operation cancelled.', 'AbortError');
    // The exact direct pins still contain two structurally equivalent v6 type
    // copies. Keep that packaging mismatch at this one boundary.
    const versions = await walletV6.supportedWalletApi(
      wallet as Parameters<typeof walletV6.supportedWalletApi>[0],
    );
    if (isAborted(signal)) throw new DOMException('Operation cancelled.', 'AbortError');
    return versions;
  };
}

function isAborted(signal?: AbortSignal): boolean {
  try {
    return signal?.aborted === true;
  } catch {
    // A malformed cancellation object must fail closed before wallet access.
    return true;
  }
}
