import { describe, expect, it } from 'vitest';
import { parseProductionWalletConfig, usesProductionWallet } from './config.js';

const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

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

  it('opts into a frozen transfer-only policy only when every public bound is explicit', () => {
    const config = parseProductionWalletConfig({
      VITE_STARKNET_CHAIN_ID: 'SN_MAIN',
      VITE_STARKNET_RPC_URL: 'https://rpc.example/rpc',
      VITE_BACKEND_BASE_URL: '/api',
      VITE_STRK20_TRANSFER_ENABLED: 'true',
      VITE_STRK20_TRANSFER_MAX_INTENTS: '2',
      VITE_STRK20_TRANSFER_MAX_RELAY_FEE: '7000000000000000',
      VITE_STRK20_TRANSFER_ALLOWED_TOKENS: '0x4718,0x1234',
    });

    expect(config.policy).toEqual({
      maxIntents: 2,
      maxRelayFee: 7_000_000_000_000_000n,
      enabledRoutes: ['transfer'],
      allowedTokens: {
        shield: [],
        unshield: [],
        transfer: ['0x4718', '0x1234'],
        swap: [],
      },
    });
    expect(Object.isFrozen(config.policy)).toBe(true);
    expect(Object.isFrozen(config.policy.enabledRoutes)).toBe(true);
    expect(Object.isFrozen(config.policy.allowedTokens)).toBe(true);
    expect(Object.isFrozen(config.policy.allowedTokens.transfer)).toBe(true);
  });

  it('admits the largest Stark felt token and rejects the field prime itself', () => {
    const base = {
      VITE_STARKNET_CHAIN_ID: 'SN_MAIN',
      VITE_STARKNET_RPC_URL: 'https://rpc.example/rpc',
      VITE_BACKEND_BASE_URL: '/api',
      VITE_STRK20_TRANSFER_ENABLED: 'true',
      VITE_STRK20_TRANSFER_MAX_INTENTS: '1',
      VITE_STRK20_TRANSFER_MAX_RELAY_FEE: '1',
    };
    const largestFelt = `0x${(STARK_FIELD_PRIME - 1n).toString(16)}`;
    const fieldPrime = `0x${STARK_FIELD_PRIME.toString(16)}`;

    expect(parseProductionWalletConfig({
      ...base,
      VITE_STRK20_TRANSFER_ALLOWED_TOKENS: largestFelt,
    }).policy.allowedTokens.transfer).toEqual([largestFelt]);
    expect(parseProductionWalletConfig({
      ...base,
      VITE_STRK20_TRANSFER_ALLOWED_TOKENS: fieldPrime,
    }).policy.enabledRoutes).toEqual([]);
  });

  it('rejects decimal token forms even when their numeric value is a valid felt', () => {
    const config = parseProductionWalletConfig({
      VITE_STARKNET_CHAIN_ID: 'SN_MAIN',
      VITE_STARKNET_RPC_URL: 'https://rpc.example/rpc',
      VITE_BACKEND_BASE_URL: '/api',
      VITE_STRK20_TRANSFER_ENABLED: 'true',
      VITE_STRK20_TRANSFER_MAX_INTENTS: '1',
      VITE_STRK20_TRANSFER_MAX_RELAY_FEE: '1',
      VITE_STRK20_TRANSFER_ALLOWED_TOKENS: '1234',
    });

    expect(config.policy.enabledRoutes).toEqual([]);
    expect(config.policy.allowedTokens.transfer).toEqual([]);
  });

  it.each([
    ['missing enablement', { VITE_STRK20_TRANSFER_ENABLED: 'true' }],
    [
      'disabled route',
      {
        VITE_STRK20_TRANSFER_ENABLED: 'false',
        VITE_STRK20_TRANSFER_MAX_INTENTS: '1',
        VITE_STRK20_TRANSFER_MAX_RELAY_FEE: '1',
        VITE_STRK20_TRANSFER_ALLOWED_TOKENS: '0x1',
      },
    ],
    [
      'zero intent bound',
      {
        VITE_STRK20_TRANSFER_ENABLED: 'true',
        VITE_STRK20_TRANSFER_MAX_INTENTS: '0',
        VITE_STRK20_TRANSFER_MAX_RELAY_FEE: '1',
        VITE_STRK20_TRANSFER_ALLOWED_TOKENS: '0x1',
      },
    ],
    [
      'zero fee bound',
      {
        VITE_STRK20_TRANSFER_ENABLED: 'true',
        VITE_STRK20_TRANSFER_MAX_INTENTS: '1',
        VITE_STRK20_TRANSFER_MAX_RELAY_FEE: '0',
        VITE_STRK20_TRANSFER_ALLOWED_TOKENS: '0x1',
      },
    ],
    [
      'invalid token',
      {
        VITE_STRK20_TRANSFER_ENABLED: 'true',
        VITE_STRK20_TRANSFER_MAX_INTENTS: '1',
        VITE_STRK20_TRANSFER_MAX_RELAY_FEE: '1',
        VITE_STRK20_TRANSFER_ALLOWED_TOKENS: 'not-a-felt',
      },
    ],
  ])('fails closed for %s without echoing route values', (_name, route) => {
    const environment = {
      VITE_STARKNET_CHAIN_ID: 'SN_MAIN',
      VITE_STARKNET_RPC_URL: 'https://rpc.example/rpc',
      VITE_BACKEND_BASE_URL: '/api',
      ...route,
    };

    expect(parseProductionWalletConfig(environment).policy).toEqual({
      maxIntents: 0,
      maxRelayFee: 0n,
      enabledRoutes: [],
      allowedTokens: { shield: [], unshield: [], transfer: [], swap: [] },
    });
    expect(JSON.stringify(parseProductionWalletConfig(environment), (_, value) => (
      typeof value === 'bigint' ? value.toString() : value
    ))).not.toContain('not-a-felt');
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
