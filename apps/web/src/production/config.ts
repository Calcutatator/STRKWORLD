import type { WalletSessionOptions } from '@strkworld/privacy';

const MAINNET_NAME = 'SN_MAIN';
const MAINNET_CHAIN_ID = '0x534e5f4d41494e';

type WalletEnvironment = Record<string, string | boolean | undefined>;

export function usesProductionWallet(environment: WalletEnvironment): boolean {
  return environment.PROD === true || environment.VITE_WALLET_MODE === 'real';
}

/** Parse only public browser configuration; secrets are never accepted here. */
export function parseProductionWalletConfig(
  environment: WalletEnvironment,
): WalletSessionOptions {
  if (environment.VITE_STARKNET_CHAIN_ID !== MAINNET_NAME) {
    throw new Error('STRKWORLD wallet configuration requires SN_MAIN.');
  }
  const rpcUrl = required(environment.VITE_STARKNET_RPC_URL, 'VITE_STARKNET_RPC_URL');
  const rpc = new URL(rpcUrl);
  if (rpc.protocol !== 'https:' || rpc.username || rpc.password) {
    throw new Error('STRKWORLD wallet RPC configuration is invalid.');
  }
  const backendBaseUrl = required(
    environment.VITE_BACKEND_BASE_URL,
    'VITE_BACKEND_BASE_URL',
  );
  if (backendBaseUrl !== '/api') {
    throw new Error('STRKWORLD wallet backend must use the same-origin /api path.');
  }

  return Object.freeze({
    rpcUrl: rpc.toString().replace(/\/$/, ''),
    backendBaseUrl,
    expectedChainId: MAINNET_CHAIN_ID,
    policy: denyAllPolicy(),
  });
}

function denyAllPolicy(): WalletSessionOptions['policy'] {
  const empty = (): readonly string[] => Object.freeze([]);
  return Object.freeze({
    maxIntents: 0,
    maxRelayFee: 0n,
    enabledRoutes: Object.freeze([]),
    allowedTokens: Object.freeze({
      shield: empty(),
      unshield: empty(),
      transfer: empty(),
      swap: empty(),
    }),
  });
}

function required(value: string | boolean | undefined, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`STRKWORLD wallet configuration is missing ${name}.`);
  }
  return value.trim();
}
