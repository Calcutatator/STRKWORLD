import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BORROW_TOKENS,
  MAX_VAULT_TOKENS,
  VAULT_TOKENS,
  parseProductionWalletConfig,
  parseRoutePolicy,
  usesProductionWallet,
  entryGateBypassFrom,
} from './config.js';
import { VAULT_MARKET_GROUPS, VAULT_MARKET_METADATA } from './vesu-markets.js';
import { EXCHANGE_CATALOG } from '../panels/exchange/catalog.js';

const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const STRK_TOKEN = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

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

  it('opts into a frozen STRK-only shield policy without relay-fee authority', () => {
    const config = parseProductionWalletConfig({
      VITE_STARKNET_CHAIN_ID: 'SN_MAIN',
      VITE_STARKNET_RPC_URL: 'https://rpc.example/rpc',
      VITE_BACKEND_BASE_URL: '/api',
      VITE_STRK20_SHIELD_ENABLED: 'true',
      VITE_STRK20_SHIELD_MAX_INTENTS: '1',
      VITE_STRK20_SHIELD_ALLOWED_TOKENS: STRK_TOKEN,
      VITE_STRK20_SHIELD_MAX_RELAY_FEE: '999999999999999999',
    });

    expect(config.policy).toEqual({
      maxIntents: 1,
      maxRelayFee: 0n,
      enabledRoutes: ['shield'],
      allowedTokens: {
        shield: [STRK_TOKEN],
        unshield: [],
        transfer: [],
        swap: [],
      },
    });
    expect(Object.isFrozen(config.policy)).toBe(true);
    expect(Object.isFrozen(config.policy.enabledRoutes)).toBe(true);
    expect(Object.isFrozen(config.policy.allowedTokens)).toBe(true);
    expect(Object.isFrozen(config.policy.allowedTokens.shield)).toBe(true);
  });

  it.each([
    ['missing enablement', { VITE_STRK20_SHIELD_MAX_INTENTS: '1', VITE_STRK20_SHIELD_ALLOWED_TOKENS: STRK_TOKEN }],
    ['zero intent bound', { VITE_STRK20_SHIELD_ENABLED: 'true', VITE_STRK20_SHIELD_MAX_INTENTS: '0', VITE_STRK20_SHIELD_ALLOWED_TOKENS: STRK_TOKEN }],
    ['malformed token', { VITE_STRK20_SHIELD_ENABLED: 'true', VITE_STRK20_SHIELD_MAX_INTENTS: '1', VITE_STRK20_SHIELD_ALLOWED_TOKENS: '0x12zz' }],
    ['a repeated token', { VITE_STRK20_SHIELD_ENABLED: 'true', VITE_STRK20_SHIELD_MAX_INTENTS: '1', VITE_STRK20_SHIELD_ALLOWED_TOKENS: `${STRK_TOKEN},${STRK_TOKEN}` }],
  ])('denies the shield route for %s without widening a valid transfer policy', (_name, shield) => {
    const config = parseProductionWalletConfig({
      VITE_STARKNET_CHAIN_ID: 'SN_MAIN',
      VITE_STARKNET_RPC_URL: 'https://rpc.example/rpc',
      VITE_BACKEND_BASE_URL: '/api',
      VITE_STRK20_TRANSFER_ENABLED: 'true',
      VITE_STRK20_TRANSFER_MAX_INTENTS: '2',
      VITE_STRK20_TRANSFER_MAX_RELAY_FEE: '7',
      VITE_STRK20_TRANSFER_ALLOWED_TOKENS: '0x1234',
      ...shield,
    });

    expect(config.policy.enabledRoutes).toEqual(['transfer']);
    expect(config.policy.allowedTokens.shield).toEqual([]);
    expect(config.policy.allowedTokens.transfer).toEqual(['0x1234']);
    expect(config.policy.maxIntents).toBe(2);
    expect(config.policy.maxRelayFee).toBe(7n);
  });

  it('composes shield and transfer conservatively using the lower intent bound', () => {
    const config = parseProductionWalletConfig({
      VITE_STARKNET_CHAIN_ID: 'SN_MAIN',
      VITE_STARKNET_RPC_URL: 'https://rpc.example/rpc',
      VITE_BACKEND_BASE_URL: '/api',
      VITE_STRK20_SHIELD_ENABLED: 'true',
      VITE_STRK20_SHIELD_MAX_INTENTS: '1',
      VITE_STRK20_SHIELD_ALLOWED_TOKENS: STRK_TOKEN,
      VITE_STRK20_TRANSFER_ENABLED: 'true',
      VITE_STRK20_TRANSFER_MAX_INTENTS: '2',
      VITE_STRK20_TRANSFER_MAX_RELAY_FEE: '7',
      VITE_STRK20_TRANSFER_ALLOWED_TOKENS: '0x1234',
    });

    expect(config.policy).toEqual({
      maxIntents: 1,
      maxRelayFee: 7n,
      enabledRoutes: ['shield', 'transfer'],
      allowedTokens: {
        shield: [STRK_TOKEN],
        unshield: [],
        transfer: ['0x1234'],
        swap: [],
      },
    });
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

  it('rejects an uppercase 0X prefix while retaining uppercase hex digits', () => {
    const base = {
      VITE_STARKNET_CHAIN_ID: 'SN_MAIN',
      VITE_STARKNET_RPC_URL: 'https://rpc.example/rpc',
      VITE_BACKEND_BASE_URL: '/api',
      VITE_STRK20_TRANSFER_ENABLED: 'true',
      VITE_STRK20_TRANSFER_MAX_INTENTS: '1',
      VITE_STRK20_TRANSFER_MAX_RELAY_FEE: '1',
    };

    expect(parseProductionWalletConfig({
      ...base,
      VITE_STRK20_TRANSFER_ALLOWED_TOKENS: '0XABCD',
    }).policy.enabledRoutes).toEqual([]);
    expect(parseProductionWalletConfig({
      ...base,
      VITE_STRK20_TRANSFER_ALLOWED_TOKENS: '0xABCD',
    }).policy.allowedTokens.transfer).toEqual(['0xABCD']);
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

describe('production unshield admission (D-062)', () => {
  const ETH = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';
  const base = {
    VITE_STARKNET_CHAIN_ID: 'SN_MAIN',
    VITE_STARKNET_RPC_URL: 'https://rpc.example/rpc',
    VITE_BACKEND_BASE_URL: '/api',
  };
  const unshield = {
    VITE_STRK20_UNSHIELD_ENABLED: 'true',
    VITE_STRK20_UNSHIELD_MAX_INTENTS: '2',
    VITE_STRK20_UNSHIELD_MAX_RELAY_FEE: '5000000000000000',
    VITE_STRK20_UNSHIELD_ALLOWED_TOKENS: STRK_TOKEN,
  };
  const denyAll = {
    maxIntents: 0,
    maxRelayFee: 0n,
    enabledRoutes: [],
    allowedTokens: { shield: [], unshield: [], transfer: [], swap: [] },
  };
  const malformed: Array<[string, Record<string, string | undefined>]> = [
    ['a disabled flag', { VITE_STRK20_UNSHIELD_ENABLED: 'false' }],
    ['a non-literal flag', { VITE_STRK20_UNSHIELD_ENABLED: 'TRUE' }],
    ['a missing intent bound', { VITE_STRK20_UNSHIELD_MAX_INTENTS: undefined }],
    ['a zero intent bound', { VITE_STRK20_UNSHIELD_MAX_INTENTS: '0' }],
    ['a negative intent bound', { VITE_STRK20_UNSHIELD_MAX_INTENTS: '-1' }],
    ['an unsafe intent bound', { VITE_STRK20_UNSHIELD_MAX_INTENTS: '9007199254740993' }],
    ['a missing relay-fee ceiling', { VITE_STRK20_UNSHIELD_MAX_RELAY_FEE: undefined }],
    ['a zero relay-fee ceiling', { VITE_STRK20_UNSHIELD_MAX_RELAY_FEE: '0' }],
    ['a fractional relay-fee ceiling', { VITE_STRK20_UNSHIELD_MAX_RELAY_FEE: '1.5' }],
    ['a relay-fee ceiling above u128', { VITE_STRK20_UNSHIELD_MAX_RELAY_FEE: (1n << 128n).toString() }],
    ['missing tokens', { VITE_STRK20_UNSHIELD_ALLOWED_TOKENS: undefined }],
    ['an empty token list', { VITE_STRK20_UNSHIELD_ALLOWED_TOKENS: '' }],
    ['a non-STRK token', { VITE_STRK20_UNSHIELD_ALLOWED_TOKENS: ETH }],
    ['STRK plus another token', { VITE_STRK20_UNSHIELD_ALLOWED_TOKENS: `${STRK_TOKEN},${ETH}` }],
    ['STRK twice', { VITE_STRK20_UNSHIELD_ALLOWED_TOKENS: `${STRK_TOKEN},${STRK_TOKEN}` }],
    ['a decimal STRK', { VITE_STRK20_UNSHIELD_ALLOWED_TOKENS: BigInt(STRK_TOKEN).toString() }],
    ['an uppercase 0X prefix', { VITE_STRK20_UNSHIELD_ALLOWED_TOKENS: `0X${STRK_TOKEN.slice(2)}` }],
  ];

  it('stays denied by default', () => {
    expect(parseProductionWalletConfig(base).policy).toEqual(denyAll);
  });

  it('opts into a frozen STRK-only unshield policy that enables nothing else', () => {
    const { policy } = parseProductionWalletConfig({ ...base, ...unshield });

    expect(policy).toEqual({
      maxIntents: 2,
      maxRelayFee: 5_000_000_000_000_000n,
      enabledRoutes: ['unshield'],
      allowedTokens: { shield: [], unshield: [STRK_TOKEN], transfer: [], swap: [] },
    });
    expect(policy).not.toHaveProperty('swap');
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.enabledRoutes)).toBe(true);
    expect(Object.isFrozen(policy.allowedTokens)).toBe(true);
    expect(Object.isFrozen(policy.allowedTokens.unshield)).toBe(true);
  });

  it('admits STRK by field-element value, not by one spelling', () => {
    const unpadded = `0x${STRK_TOKEN.slice(3)}`;
    const policy = parseRoutePolicy({ ...unshield, VITE_STRK20_UNSHIELD_ALLOWED_TOKENS: unpadded });
    expect(policy.enabledRoutes).toEqual(['unshield']);
    expect(policy.allowedTokens.unshield).toEqual([unpadded]);
  });

  it.each(malformed)('resolves %s to deny-all', (_name, override) => {
    const policy = parseRoutePolicy({ ...unshield, ...override });
    expect(policy).toEqual(denyAll);
    expect(JSON.stringify(policy, (_, value) => (typeof value === 'bigint' ? value.toString() : value)))
      .not.toContain(ETH.slice(2));
  });

  it.each(malformed)('denies unshield for %s without widening a valid transfer policy', (_name, override) => {
    const policy = parseRoutePolicy({
      ...unshield,
      ...override,
      VITE_STRK20_TRANSFER_ENABLED: 'true',
      VITE_STRK20_TRANSFER_MAX_INTENTS: '3',
      VITE_STRK20_TRANSFER_MAX_RELAY_FEE: '7',
      VITE_STRK20_TRANSFER_ALLOWED_TOKENS: '0x1234',
    });
    expect(policy.enabledRoutes).toEqual(['transfer']);
    expect(policy.allowedTokens.unshield).toEqual([]);
    expect(policy.maxIntents).toBe(3);
    expect(policy.maxRelayFee).toBe(7n);
  });

  it('keeps the strictest relay-fee ceiling and intent bound when transfer is enabled too', () => {
    const transfer = {
      VITE_STRK20_TRANSFER_ENABLED: 'true',
      VITE_STRK20_TRANSFER_ALLOWED_TOKENS: STRK_TOKEN,
    };

    // Unshield has the lower fee ceiling, transfer the lower intent bound.
    expect(parseRoutePolicy({
      ...unshield,
      ...transfer,
      VITE_STRK20_TRANSFER_MAX_INTENTS: '1',
      VITE_STRK20_TRANSFER_MAX_RELAY_FEE: '7000000000000000',
    })).toEqual({
      maxIntents: 1,
      maxRelayFee: 5_000_000_000_000_000n,
      enabledRoutes: ['unshield', 'transfer'],
      allowedTokens: { shield: [], unshield: [STRK_TOKEN], transfer: [STRK_TOKEN], swap: [] },
    });
    // And the other way round.
    expect(parseRoutePolicy({
      ...unshield,
      ...transfer,
      VITE_STRK20_TRANSFER_MAX_INTENTS: '4',
      VITE_STRK20_TRANSFER_MAX_RELAY_FEE: '3000000000000000',
    })).toMatchObject({ maxIntents: 2, maxRelayFee: 3_000_000_000_000_000n });
  });

  it('bounds intents across all three routes but relay fees only across the relayed two', () => {
    const shield = {
      VITE_STRK20_SHIELD_ENABLED: 'true',
      VITE_STRK20_SHIELD_MAX_INTENTS: '1',
      VITE_STRK20_SHIELD_ALLOWED_TOKENS: STRK_TOKEN,
    };

    expect(parseRoutePolicy({
      ...shield,
      ...unshield,
      VITE_STRK20_TRANSFER_ENABLED: 'true',
      VITE_STRK20_TRANSFER_MAX_INTENTS: '3',
      VITE_STRK20_TRANSFER_MAX_RELAY_FEE: '9000000000000000',
      VITE_STRK20_TRANSFER_ALLOWED_TOKENS: '0x1234',
    })).toEqual({
      maxIntents: 1,
      maxRelayFee: 5_000_000_000_000_000n,
      enabledRoutes: ['shield', 'unshield', 'transfer'],
      allowedTokens: { shield: [STRK_TOKEN], unshield: [STRK_TOKEN], transfer: ['0x1234'], swap: [] },
    });
    expect(parseRoutePolicy({ ...shield, ...unshield })).toEqual({
      maxIntents: 1,
      maxRelayFee: 5_000_000_000_000_000n,
      enabledRoutes: ['shield', 'unshield'],
      allowedTokens: { shield: [STRK_TOKEN], unshield: [STRK_TOKEN], transfer: [], swap: [] },
    });
  });

  it('ships the example environment with every browser route, unshield included, denied', () => {
    const example = readFileSync(new URL('../../../../.env.production.example', import.meta.url), 'utf8');
    const environment: Record<string, string> = {};
    for (const line of example.split('\n')) {
      const match = /^(VITE_[A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match) environment[match[1]!] = match[2]!;
    }

    for (const key of ['ENABLED', 'MAX_INTENTS', 'MAX_RELAY_FEE', 'ALLOWED_TOKENS']) {
      expect(environment, key).toHaveProperty(`VITE_STRK20_UNSHIELD_${key}`);
    }
    expect(environment.VITE_STRK20_UNSHIELD_ENABLED).toBe('false');
    expect(parseRoutePolicy(environment)).toEqual(denyAll);
  });
});

describe('production Endur staking admission (D-063)', () => {
  const XSTRK = '0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a';
  const ETH = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';
  const base = {
    VITE_STARKNET_CHAIN_ID: 'SN_MAIN',
    VITE_STARKNET_RPC_URL: 'https://rpc.example/rpc',
    VITE_BACKEND_BASE_URL: '/api',
  };
  const stake = {
    VITE_STRK20_STAKE_ENABLED: 'true',
    VITE_STRK20_STAKE_MAX_RELAY_FEE: '4000000000000000',
    VITE_STRK20_STAKE_ALLOWED_TOKENS: `${STRK_TOKEN},${XSTRK}`,
  };
  const transfer = {
    VITE_STRK20_TRANSFER_ENABLED: 'true',
    VITE_STRK20_TRANSFER_MAX_INTENTS: '3',
    VITE_STRK20_TRANSFER_MAX_RELAY_FEE: '5000000000000000',
    VITE_STRK20_TRANSFER_ALLOWED_TOKENS: STRK_TOKEN,
  };

  // The privacy package's first import pulls starknet and the avnu SDK. Under a
  // loaded full run it can take longer than vitest's 5 s default, which made
  // this pin a known timeout flake, so the pins that import it allow longer.
  it('pins the inlined xSTRK felt to the privacy package constant', async () => {
    const { XSTRK_TOKEN } = await import('./config.js');
    const { ENDUR_XSTRK } = await import('@strkworld/privacy');
    expect(BigInt(XSTRK_TOKEN)).toBe(BigInt(ENDUR_XSTRK));
    expect(XSTRK_TOKEN).toBe(XSTRK);
  }, 30_000);

  it('stays denied by default, with no stake list at all', () => {
    const { policy } = parseProductionWalletConfig(base);
    expect(policy.enabledRoutes).toEqual([]);
    expect('stake' in policy.allowedTokens).toBe(false);
  });

  it('opts into staking alone: STRK and xSTRK, its relay ceiling, one intent at a time', () => {
    const { policy } = parseProductionWalletConfig({ ...base, ...stake });
    expect(policy.enabledRoutes).toEqual(['stake']);
    expect(policy.maxRelayFee).toBe(4_000_000_000_000_000n);
    expect(policy.maxIntents).toBe(1);
    expect(policy.allowedTokens.stake).toEqual([STRK_TOKEN, XSTRK]);
    expect(policy.allowedTokens.shield).toEqual([]);
    expect(policy.allowedTokens.transfer).toEqual([]);
    expect(Object.isFrozen(policy.allowedTokens.stake)).toBe(true);
  });

  it('accepts the pair in either order', () => {
    const { policy } = parseProductionWalletConfig({
      ...base,
      ...stake,
      VITE_STRK20_STAKE_ALLOWED_TOKENS: `${XSTRK},${STRK_TOKEN}`,
    });
    expect(policy.enabledRoutes).toEqual(['stake']);
  });

  it('never narrows another route: it adds its relay ceiling but no intent bound', () => {
    const { policy } = parseProductionWalletConfig({ ...base, ...transfer, ...stake });
    expect(policy.enabledRoutes).toEqual(['transfer', 'stake']);
    expect(policy.maxIntents).toBe(3);
    expect(policy.maxRelayFee).toBe(4_000_000_000_000_000n);
  });

  it.each([
    ['a disabled flag', { VITE_STRK20_STAKE_ENABLED: 'false' }],
    ['a non-literal flag', { VITE_STRK20_STAKE_ENABLED: 'TRUE' }],
    ['a missing relay-fee ceiling', { VITE_STRK20_STAKE_MAX_RELAY_FEE: undefined }],
    ['a zero relay-fee ceiling', { VITE_STRK20_STAKE_MAX_RELAY_FEE: '0' }],
    ['a relay-fee ceiling above u128', { VITE_STRK20_STAKE_MAX_RELAY_FEE: (1n << 128n).toString() }],
    ['missing tokens', { VITE_STRK20_STAKE_ALLOWED_TOKENS: undefined }],
    ['STRK alone', { VITE_STRK20_STAKE_ALLOWED_TOKENS: STRK_TOKEN }],
    ['xSTRK alone', { VITE_STRK20_STAKE_ALLOWED_TOKENS: XSTRK }],
    ['STRK and another token', { VITE_STRK20_STAKE_ALLOWED_TOKENS: `${STRK_TOKEN},${ETH}` }],
    ['a third token', { VITE_STRK20_STAKE_ALLOWED_TOKENS: `${STRK_TOKEN},${XSTRK},${ETH}` }],
    ['STRK twice', { VITE_STRK20_STAKE_ALLOWED_TOKENS: `${STRK_TOKEN},${STRK_TOKEN}` }],
  ])('keeps staking denied on %s, and touches no other route', (_label, override) => {
    const { policy } = parseProductionWalletConfig({ ...base, ...transfer, ...stake, ...override });
    expect(policy.enabledRoutes).toEqual(['transfer']);
    expect('stake' in policy.allowedTokens).toBe(false);
    expect(policy.maxRelayFee).toBe(5_000_000_000_000_000n);
  });
});

describe('production shield admission for any token (D-072)', () => {
  const ETH = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';
  const USDC = '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb';
  const USDT = '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8';
  const WBTC = '0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac';
  /** The allowlist the Railway deployment sets: STRK, ETH, USDC, USDT and WBTC. */
  const RAILWAY = [STRK_TOKEN, ETH, USDC, USDT, WBTC];
  const shield = (tokens: string | undefined) => ({
    VITE_STRK20_SHIELD_ENABLED: 'true',
    VITE_STRK20_SHIELD_MAX_INTENTS: '1',
    VITE_STRK20_SHIELD_ALLOWED_TOKENS: tokens,
  });
  const denyAll = {
    maxIntents: 0,
    maxRelayFee: 0n,
    enabledRoutes: [],
    allowedTokens: { shield: [], unshield: [], transfer: [], swap: [] },
  };
  /** 16 distinct contract addresses. */
  const sixteen = Array.from({ length: 16 }, (_, index) => `0x${(0x1000 + index).toString(16)}`);

  it('admits exactly the Railway list, in order, frozen, with no relay-fee authority', () => {
    const policy = parseRoutePolicy(shield(RAILWAY.join(',')));
    expect(policy).toEqual({
      maxIntents: 1,
      maxRelayFee: 0n,
      enabledRoutes: ['shield'],
      allowedTokens: { shield: RAILWAY, unshield: [], transfer: [], swap: [] },
    });
    expect(Object.isFrozen(policy.allowedTokens.shield)).toBe(true);
    // A space after each comma, as a hand-edited variable often has, is the same list.
    expect(parseRoutePolicy(shield(RAILWAY.join(', '))).allowedTokens.shield).toEqual(RAILWAY);
  });

  it('documents a Railway value that parses to exactly those five tokens', () => {
    const example = readFileSync(new URL('../../../../.env.production.example', import.meta.url), 'utf8');
    const documented = example.split('\n').map((line) => line.trim())
      .find((line) => /^# 0x[0-9a-f]{64}(?:,0x[0-9a-f]{64})+$/.test(line));
    expect(documented).toBeDefined();
    expect(parseRoutePolicy(shield(documented!.slice(2))).allowedTokens.shield).toEqual(RAILWAY);
  });

  it('admits any single token, STRK or not', () => {
    for (const token of [STRK_TOKEN, USDC, WBTC, '0x1234']) {
      expect(parseRoutePolicy(shield(token)).allowedTokens.shield, token).toEqual([token]);
    }
  });

  it('keeps shield STRK-free when the list is, without touching unshield\'s STRK-only rule (D-062)', () => {
    const policy = parseRoutePolicy({
      ...shield(`${USDC},${ETH}`),
      VITE_STRK20_UNSHIELD_ENABLED: 'true',
      VITE_STRK20_UNSHIELD_MAX_INTENTS: '1',
      VITE_STRK20_UNSHIELD_MAX_RELAY_FEE: '5',
      VITE_STRK20_UNSHIELD_ALLOWED_TOKENS: USDC,
    });
    expect(policy.enabledRoutes).toEqual(['shield']);
    expect(policy.allowedTokens.shield).toEqual([USDC, ETH]);
    expect(policy.allowedTokens.unshield).toEqual([]);
  });

  it('bounds the list at 16 tokens', () => {
    expect(parseRoutePolicy(shield(sixteen.join(','))).allowedTokens.shield).toEqual(sixteen);
    expect(parseRoutePolicy(shield([...sixteen, '0x2000'].join(',')))).toEqual(denyAll);
  });

  it.each([
    ['the same token twice', `${STRK_TOKEN},${STRK_TOKEN}`],
    ['one token padded and unpadded', `${USDC},0x${USDC.slice(3)}`],
    ['one token in two cases', `${ETH},0x${ETH.slice(2).toUpperCase()}`],
    ['a repeat at the end of a long list', [...RAILWAY, STRK_TOKEN].join(',')],
  ])('denies shield whole for %s, a repeat by field value', (_name, tokens) => {
    expect(parseRoutePolicy(shield(tokens))).toEqual(denyAll);
  });

  it.each([
    ['a missing list', undefined],
    ['an empty list', ''],
    ['a blank entry', ' '],
    ['a trailing comma', `${STRK_TOKEN},`],
    ['a leading comma', `,${STRK_TOKEN}`],
    ['an empty entry between two', `${STRK_TOKEN},,${ETH}`],
    ['a symbol', 'STRK'],
    ['a decimal address', BigInt(STRK_TOKEN).toString()],
    ['an uppercase 0X prefix', `0X${STRK_TOKEN.slice(2)}`],
    ['a non-hex digit', '0x12zz'],
    ['zero', '0x0'],
    ['more than 64 hex digits', `0x0${STRK_TOKEN.slice(2)}`],
    ['a felt at or above 2^251', `0x${(1n << 251n).toString(16)}`],
    ['one malformed entry among good ones', `${STRK_TOKEN},${ETH},0xnothex,${USDC}`],
    ['a separator other than a comma', `${STRK_TOKEN};${ETH}`],
  ])('denies shield whole for %s', (_name, tokens) => {
    expect(parseRoutePolicy(shield(tokens))).toEqual(denyAll);
  });

  it('denies shield for a partial tuple, whatever the list', () => {
    expect(parseRoutePolicy({ ...shield(RAILWAY.join(',')), VITE_STRK20_SHIELD_MAX_INTENTS: undefined })).toEqual(denyAll);
    expect(parseRoutePolicy({ ...shield(RAILWAY.join(',')), VITE_STRK20_SHIELD_ENABLED: 'false' })).toEqual(denyAll);
  });

  it('admits the highest contract address and nothing past it', () => {
    const highest = `0x${((1n << 251n) - 1n).toString(16)}`;
    expect(parseRoutePolicy(shield(highest)).allowedTokens.shield).toEqual([highest]);
  });
});

describe('production Vault admission (D-077, D-079, D-081)', () => {
  const ETH = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';
  const USDC = '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb';
  const WBTC = '0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac';
  const STRKBTC = '0x0787150e306e6eae6e3f79dea881770e8bbff2c1b8eb490f969669ee945b3135';
  const USDC_E = '0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8';
  /** sUSN: pinned since D-081, though the STRK20 pool has never held it, and collateral only. */
  const SUSN = '0x02411565ef1a14decfbe83d2e987cced918cd752508a3d9c55deb67148d14d17';
  /** LORDS: a real Starknet token Vesu lists in no pool, so no vault is pinned. */
  const LORDS = '0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49';
  /** The list the Railway test deployment sets (D-081): every pinned market, in pinned order. */
  const RAILWAY = [...VAULT_TOKENS];
  const base = {
    VITE_STARKNET_CHAIN_ID: 'SN_MAIN',
    VITE_STARKNET_RPC_URL: 'https://rpc.example/rpc',
    VITE_BACKEND_BASE_URL: '/api',
  };
  const vault = (tokens: string | undefined = STRK_TOKEN) => ({
    VITE_STRK20_VAULT_ENABLED: 'true',
    VITE_STRK20_VAULT_ALLOWED_TOKENS: tokens,
  });
  const transfer = {
    VITE_STRK20_TRANSFER_ENABLED: 'true',
    VITE_STRK20_TRANSFER_MAX_INTENTS: '3',
    VITE_STRK20_TRANSFER_MAX_RELAY_FEE: '5000000000000000',
    VITE_STRK20_TRANSFER_ALLOWED_TOKENS: STRK_TOKEN,
  };

  it('pins the Vault token to the vault asset the privacy package lends', async () => {
    const { VESU_VSTRK_ASSET } = await import('@strkworld/privacy');
    expect(BigInt(STRK_TOKEN)).toBe(BigInt(VESU_VSTRK_ASSET));
  }, 30_000);

  it('pins the generated Vault tokens and their metadata to the privacy package’s token → vault map, in its order', async () => {
    const { MAX_VAULT_MARKETS, VAULT_MARKETS } = await import('@strkworld/privacy');
    expect(VAULT_TOKENS).toEqual(VAULT_MARKETS.map((market) => market.token));
    expect(MAX_VAULT_TOKENS).toBe(23);
    expect(MAX_VAULT_TOKENS).toBe(VAULT_MARKETS.length);
    expect(MAX_VAULT_TOKENS).toBeLessThanOrEqual(MAX_VAULT_MARKETS);
    expect(Object.isFrozen(VAULT_TOKENS)).toBe(true);
    // What the counter shows agrees with what the chain reported, token for token.
    expect(VAULT_MARKET_METADATA.map(({ token, symbol, decimals, poolName, curation, lendable }) => ({ token, symbol, decimals, poolName, curation, lendable })))
      .toEqual(VAULT_MARKETS.map(({ token, symbol, decimals, poolName, curation, lendable }) => ({ token, symbol, decimals, poolName, curation, lendable })));
    for (const market of VAULT_MARKET_METADATA) expect(VAULT_MARKET_GROUPS, market.symbol).toContain(market.group);
  }, 30_000);

  it('agrees with the Exchange catalog on every token both describe', () => {
    const shared = EXCHANGE_CATALOG.filter((asset) => VAULT_MARKET_METADATA.some((market) => BigInt(market.token) === BigInt(asset.token)));
    expect(shared.map((asset) => asset.symbol)).toEqual(['STRK', 'ETH', 'USDC', 'USDT', 'WBTC', 'strkBTC']);
    for (const asset of shared) {
      expect(VAULT_MARKET_METADATA.find((market) => BigInt(market.token) === BigInt(asset.token)), asset.symbol)
        .toMatchObject({ symbol: asset.symbol, decimals: asset.decimals });
    }
  });

  it('stays denied by default: no Vault route and no Vault list at all', () => {
    const { policy } = parseProductionWalletConfig(base);
    expect(policy.enabledRoutes).toEqual([]);
    expect('vault' in policy.allowedTokens).toBe(false);
  });

  it('opts into the Vault alone: no relay-fee authority, one action at a time', () => {
    const { policy } = parseProductionWalletConfig({ ...base, ...vault() });
    expect(policy.enabledRoutes).toEqual(['vault']);
    expect(policy.allowedTokens.vault).toEqual([STRK_TOKEN]);
    expect(policy.maxRelayFee).toBe(0n);
    expect(policy.maxIntents).toBe(1);
    expect(policy.allowedTokens.shield).toEqual([]);
    expect(Object.isFrozen(policy.allowedTokens.vault)).toBe(true);
  });

  it('admits exactly the Railway list, all twenty-three, in the order given, frozen', () => {
    const { policy } = parseProductionWalletConfig({ ...base, ...vault(RAILWAY.join(',')) });
    expect(policy.enabledRoutes).toEqual(['vault']);
    expect(policy.allowedTokens.vault).toEqual(RAILWAY);
    expect(RAILWAY).toHaveLength(23);
    expect(Object.isFrozen(policy.allowedTokens.vault)).toBe(true);
    // A space after each comma is the same list; another order is kept as given.
    expect(parseRoutePolicy(vault(RAILWAY.join(', '))).allowedTokens.vault).toEqual(RAILWAY);
    expect(parseRoutePolicy(vault(`${WBTC},${USDC}`)).allowedTokens.vault).toEqual([WBTC, USDC]);
    expect(parseRoutePolicy(vault([...RAILWAY].reverse().join(','))).allowedTokens.vault).toEqual([...RAILWAY].reverse());
  });

  it.each([
    ['the example environment', '../../../../.env.production.example', /^# (0x[0-9a-f]{64}(?:,0x[0-9a-f]{64})+)$/m],
    ['RAILWAY.md', '../../../../deploy/RAILWAY.md', /\| `VITE_STRK20_VAULT_ALLOWED_TOKENS` \| `(0x[0-9a-f]{64}(?:,0x[0-9a-f]{64})+)`/],
  ])('documents a Railway value in %s that parses to exactly every pinned market', (_label, path, pattern) => {
    const text = readFileSync(new URL(path, import.meta.url), 'utf8');
    const from = path.endsWith('.example') ? text.indexOf('# --- Browser Vault admission') : text.indexOf('## The Vault probe');
    expect(from).toBeGreaterThanOrEqual(0);
    const documented = pattern.exec(text.slice(from))?.[1];
    expect(documented).toBeDefined();
    expect(parseRoutePolicy(vault(documented!)).allowedTokens.vault).toEqual(RAILWAY);
  });

  it('needs no STRK on the list: any single pinned token opens the Vault', () => {
    for (const token of VAULT_TOKENS.filter((pinned) => pinned !== STRK_TOKEN)) {
      expect(parseRoutePolicy(vault(token)).allowedTokens.vault, token).toEqual([token]);
    }
    // strkBTC through its curated pool, the bridged USDC.e beside Circle's USDC, and sUSN, which
    // the pool has never held and Vesu lends none of out: admission is the pinned list alone (D-081).
    expect(parseRoutePolicy(vault(`${STRKBTC},${USDC_E},${USDC},${SUSN}`)).allowedTokens.vault).toEqual([STRKBTC, USDC_E, USDC, SUSN]);
  });

  it('never narrows another route', () => {
    const { policy } = parseProductionWalletConfig({ ...base, ...transfer, ...vault(RAILWAY.join(',')) });
    expect(policy.enabledRoutes).toEqual(['transfer', 'vault']);
    expect(policy.maxIntents).toBe(3);
    expect(policy.maxRelayFee).toBe(5_000_000_000_000_000n);
  });

  it.each([
    ['a disabled flag', { VITE_STRK20_VAULT_ENABLED: 'false' }],
    ['a non-literal flag', { VITE_STRK20_VAULT_ENABLED: 'TRUE' }],
    ['an unset flag', { VITE_STRK20_VAULT_ENABLED: undefined }],
    ['missing tokens', { VITE_STRK20_VAULT_ALLOWED_TOKENS: undefined }],
    ['an empty token list', { VITE_STRK20_VAULT_ALLOWED_TOKENS: '' }],
    ['a blank entry', { VITE_STRK20_VAULT_ALLOWED_TOKENS: ' ' }],
    ['a trailing comma', { VITE_STRK20_VAULT_ALLOWED_TOKENS: `${STRK_TOKEN},` }],
    ['an empty entry between two', { VITE_STRK20_VAULT_ALLOWED_TOKENS: `${STRK_TOKEN},,${USDC}` }],
    ['a symbol', { VITE_STRK20_VAULT_ALLOWED_TOKENS: 'USDC' }],
    ['a decimal STRK', { VITE_STRK20_VAULT_ALLOWED_TOKENS: BigInt(STRK_TOKEN).toString() }],
    ['an uppercase 0X prefix', { VITE_STRK20_VAULT_ALLOWED_TOKENS: `0X${USDC.slice(2)}` }],
    ['a non-hex digit', { VITE_STRK20_VAULT_ALLOWED_TOKENS: `${STRK_TOKEN},0xnothex` }],
    ['zero', { VITE_STRK20_VAULT_ALLOWED_TOKENS: '0x0' }],
    ['more than 64 hex digits', { VITE_STRK20_VAULT_ALLOWED_TOKENS: `0x0${USDC.slice(2)}` }],
    ['a separator other than a comma', { VITE_STRK20_VAULT_ALLOWED_TOKENS: `${STRK_TOKEN};${USDC}` }],
    ['STRK twice', { VITE_STRK20_VAULT_ALLOWED_TOKENS: `${STRK_TOKEN},${STRK_TOKEN}` }],
    ['one token padded and unpadded', { VITE_STRK20_VAULT_ALLOWED_TOKENS: `${USDC},0x${USDC.slice(3)}` }],
    ['one token in two cases', { VITE_STRK20_VAULT_ALLOWED_TOKENS: `${ETH},0x${ETH.slice(2).toUpperCase()}` }],
    ['a repeat at the end of the full list', { VITE_STRK20_VAULT_ALLOWED_TOKENS: [...RAILWAY, WBTC].join(',') }],
    ['strkBTC twice, padded and unpadded', { VITE_STRK20_VAULT_ALLOWED_TOKENS: `${STRKBTC},0x${STRKBTC.slice(3)}` }],
    ['LORDS, which Vesu lists in no pool', { VITE_STRK20_VAULT_ALLOWED_TOKENS: LORDS }],
    ['an unpinned token beside pinned ones', { VITE_STRK20_VAULT_ALLOWED_TOKENS: `${STRK_TOKEN},${USDC},${LORDS}` }],
    ['a pinned vault in place of its token', { VITE_STRK20_VAULT_ALLOWED_TOKENS: '0x06d6d2bf905dd199c78f2e421521d8473042737be9f47904e7578536c10f279d' }],
    ['a token nobody lends', { VITE_STRK20_VAULT_ALLOWED_TOKENS: '0x1234' }],
    ['a list longer than the pinned vaults', { VITE_STRK20_VAULT_ALLOWED_TOKENS: [...RAILWAY, '0x1234'].join(',') }],
  ])('keeps the whole Vault denied on %s, and touches no other route', (_label, override) => {
    const { policy } = parseProductionWalletConfig({ ...base, ...transfer, ...vault(), ...override });
    expect(policy.enabledRoutes).toEqual(['transfer']);
    expect('vault' in policy.allowedTokens).toBe(false);
  });

  it('ships the example environment with the Vault denied', () => {
    const example = readFileSync(new URL('../../../../.env.production.example', import.meta.url), 'utf8');
    const environment: Record<string, string> = {};
    for (const line of example.split('\n')) {
      const match = /^(VITE_[A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match) environment[match[1]!] = match[2]!;
    }
    expect(environment.VITE_STRK20_VAULT_ENABLED).toBe('false');
    expect(environment).toHaveProperty('VITE_STRK20_VAULT_ALLOWED_TOKENS');
    expect(parseRoutePolicy(environment).enabledRoutes).toEqual([]);
  });

  it('declares both Vault variables as Docker build arguments, so Railway can pass them', () => {
    const dockerfile = readFileSync(new URL('../../../../deploy/fly/Dockerfile', import.meta.url), 'utf8');
    for (const name of ['VITE_STRK20_VAULT_ENABLED', 'VITE_STRK20_VAULT_ALLOWED_TOKENS']) {
      expect(dockerfile, name).toMatch(new RegExp(`^ARG ${name}$`, 'm'));
    }
  });
});

describe('the temporary entry-gate bypass', () => {
  it('is on only for exactly "true"', () => {
    expect(entryGateBypassFrom({ VITE_ENTRY_GATE_BYPASS: 'true' })).toBe(true);
    expect(entryGateBypassFrom({ VITE_ENTRY_GATE_BYPASS: '1' })).toBe(false);
    expect(entryGateBypassFrom({ VITE_ENTRY_GATE_BYPASS: true })).toBe(false);
    expect(entryGateBypassFrom({})).toBe(false);
    expect(entryGateBypassFrom(undefined)).toBe(false);
  });
});

describe('production Borrow counter admission (D-083)', () => {
  const base = {
    VITE_STARKNET_CHAIN_ID: 'SN_MAIN',
    VITE_STARKNET_RPC_URL: 'https://rpc.example/rpc',
    VITE_BACKEND_BASE_URL: '/api',
  };
  const vault = { VITE_STRK20_VAULT_ENABLED: 'true', VITE_STRK20_VAULT_ALLOWED_TOKENS: STRK_TOKEN };

  it('pins the borrow tokens to the privacy package\'s, in its order', async () => {
    const { BORROW_TOKENS: PINNED } = await import('@strkworld/privacy');
    expect(BORROW_TOKENS).toEqual(PINNED);
    expect(Object.isFrozen(BORROW_TOKENS)).toBe(true);
  }, 30_000);

  it('stays denied by default', () => {
    const { policy } = parseProductionWalletConfig(base);
    expect(policy.enabledRoutes).toEqual([]);
    expect('borrow' in policy.allowedTokens).toBe(false);
  });

  it('opts in with one switch, admitting exactly the five pinned tokens and narrowing nothing', () => {
    const { policy } = parseProductionWalletConfig({ ...base, ...vault, VITE_STRK20_BORROW_ENABLED: 'true' });
    expect(policy.enabledRoutes).toEqual(['vault', 'borrow']);
    expect(policy.allowedTokens.borrow).toEqual(BORROW_TOKENS);
    expect(policy.allowedTokens.vault).toEqual([STRK_TOKEN]);
    expect(policy.maxRelayFee).toBe(0n);
    expect(policy.maxIntents).toBe(1);
    expect(Object.isFrozen(policy.allowedTokens.borrow)).toBe(true);
  });

  it.each([['false'], ['TRUE'], ['1'], [undefined]])('keeps it denied for the value %s', (value) => {
    const { policy } = parseProductionWalletConfig({ ...base, ...vault, VITE_STRK20_BORROW_ENABLED: value });
    expect(policy.enabledRoutes).toEqual(['vault']);
    expect('borrow' in policy.allowedTokens).toBe(false);
  });

  it('ships the example environment with borrowing denied, and declares its build argument', () => {
    const example = readFileSync(new URL('../../../../.env.production.example', import.meta.url), 'utf8');
    expect(example).toMatch(/^VITE_STRK20_BORROW_ENABLED=false$/m);
    const dockerfile = readFileSync(new URL('../../../../deploy/fly/Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toMatch(/^ARG VITE_STRK20_BORROW_ENABLED$/m);
    const railway = readFileSync(new URL('../../../../deploy/RAILWAY.md', import.meta.url), 'utf8');
    expect(railway).toMatch(/\| `VITE_STRK20_BORROW_ENABLED` \| `true` \|/);
  });
});

describe('Endur staking and unstaking admission (D-085)', () => {
  const XSTRK = '0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a';
  const base = {
    VITE_STARKNET_CHAIN_ID: 'SN_MAIN',
    VITE_STARKNET_RPC_URL: 'https://rpc.example/rpc',
    VITE_BACKEND_BASE_URL: '/api',
  };
  /** The test deployment's stake values (deploy/RAILWAY.md). */
  const stake = {
    VITE_STRK20_STAKE_ENABLED: 'true',
    VITE_STRK20_STAKE_MAX_RELAY_FEE: '10000000000000000000',
    VITE_STRK20_STAKE_ALLOWED_TOKENS: `${STRK_TOKEN},${XSTRK}`,
  };

  it('admits unstaking with its one switch, and staking with the test deployment values', () => {
    const { policy } = parseProductionWalletConfig({ ...base, ...stake, VITE_STRK20_UNSTAKE_ENABLED: 'true' });
    expect(policy.enabledRoutes).toEqual(['stake', 'unstake']);
    expect(policy.allowedTokens.stake).toEqual([STRK_TOKEN, XSTRK]);
    // Unstaking takes no token list: xSTRK in and STRK out are pinned.
    expect('unstake' in policy.allowedTokens).toBe(false);
  });

  it('keeps each independent: one never enables the other', () => {
    expect(parseRoutePolicy({ ...base, VITE_STRK20_UNSTAKE_ENABLED: 'true' }).enabledRoutes).toEqual(['unstake']);
    expect(parseRoutePolicy({ ...base, ...stake }).enabledRoutes).toEqual(['stake']);
  });

  it.each([['false'], ['TRUE'], ['1'], [undefined]])('keeps unstaking shut for %s', (flag) => {
    expect(parseRoutePolicy({ ...base, VITE_STRK20_UNSTAKE_ENABLED: flag }).enabledRoutes).toEqual([]);
  });

  it('ships the example environment with both denied, and declares the switch as a Docker build argument', () => {
    const example = readFileSync(new URL('../../../../.env.production.example', import.meta.url), 'utf8');
    const environment: Record<string, string> = {};
    for (const line of example.split('\n')) {
      const match = /^(VITE_[A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match) environment[match[1]!] = match[2]!;
    }
    expect(environment.VITE_STRK20_STAKE_ENABLED).toBe('false');
    expect(environment.VITE_STRK20_UNSTAKE_ENABLED).toBe('false');
    expect(parseRoutePolicy(environment).enabledRoutes).toEqual([]);
    const dockerfile = readFileSync(new URL('../../../../deploy/fly/Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toMatch(/^ARG VITE_STRK20_UNSTAKE_ENABLED$/m);
  });
});
