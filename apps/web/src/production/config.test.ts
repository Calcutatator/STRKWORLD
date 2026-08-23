import { describe, expect, it } from 'vitest';
import { parseProductionWalletConfig, usesProductionWallet } from './config.js';

describe('production wallet configuration', () => {
  it('builds a mainnet same-origin session with every transaction route denied', () => {
    const config = parseProductionWalletConfig({
      VITE_STARKNET_CHAIN_ID: 'SN_MAIN',
      VITE_STARKNET_RPC_URL: 'https://rpc.example/rpc',
      VITE_BACKEND_BASE_URL: '/api',
    });

    expect(config).toEqual({
      rpcUrl: 'https://rpc.example/rpc',
      backendBaseUrl: '/api',
      expectedChainId: '0x534e5f4d41494e',
      policy: {
        maxIntents: 0,
        maxRelayFee: 0n,
        enabledRoutes: [],
        allowedTokens: { shield: [], unshield: [], transfer: [], swap: [] },
      },
    });
    expect(Object.isFrozen(config.policy)).toBe(true);
    expect(Object.isFrozen(config.policy.allowedTokens.transfer)).toBe(true);
  });

  it('always uses the real wallet in production and only opts in explicitly during development', () => {
    expect(usesProductionWallet({ PROD: true })).toBe(true);
    expect(usesProductionWallet({ PROD: false, VITE_WALLET_MODE: 'real' })).toBe(true);
    expect(usesProductionWallet({ PROD: false })).toBe(false);
  });

  it.each([
    [
      'a non-mainnet chain',
      {
        VITE_STARKNET_CHAIN_ID: 'SN_SEPOLIA',
        VITE_STARKNET_RPC_URL: 'https://rpc.example',
        VITE_BACKEND_BASE_URL: '/api',
      },
    ],
    [
      'an insecure browser RPC',
      {
        VITE_STARKNET_CHAIN_ID: 'SN_MAIN',
        VITE_STARKNET_RPC_URL: 'http://rpc.example',
        VITE_BACKEND_BASE_URL: '/api',
      },
    ],
    [
      'RPC credentials embedded in public configuration',
      {
        VITE_STARKNET_CHAIN_ID: 'SN_MAIN',
        VITE_STARKNET_RPC_URL: 'https://key:secret@rpc.example',
        VITE_BACKEND_BASE_URL: '/api',
      },
    ],
    [
      'a cross-origin backend URL',
      {
        VITE_STARKNET_CHAIN_ID: 'SN_MAIN',
        VITE_STARKNET_RPC_URL: 'https://rpc.example',
        VITE_BACKEND_BASE_URL: 'https://backend.example',
      },
    ],
  ])('fails closed on %s', (_name, environment) => {
    expect(() => parseProductionWalletConfig(environment)).toThrow();
  });
});
