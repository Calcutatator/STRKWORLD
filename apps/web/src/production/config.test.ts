import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseProductionWalletConfig, parseRoutePolicy, usesProductionWallet } from './config.js';

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
    ['malformed token', { VITE_STRK20_SHIELD_ENABLED: 'true', VITE_STRK20_SHIELD_MAX_INTENTS: '1', VITE_STRK20_SHIELD_ALLOWED_TOKENS: '0x1234' }],
    ['multiple tokens', { VITE_STRK20_SHIELD_ENABLED: 'true', VITE_STRK20_SHIELD_MAX_INTENTS: '1', VITE_STRK20_SHIELD_ALLOWED_TOKENS: `${STRK_TOKEN},${STRK_TOKEN}` }],
    // D-072's "any token" still meets D-056's STRK-only parser: listing the
    // Exchange catalog's ETH, USDC, USDT and WBTC beside STRK switches shield off.
    ['STRK with the Exchange catalog\'s other tokens', {
      VITE_STRK20_SHIELD_ENABLED: 'true',
      VITE_STRK20_SHIELD_MAX_INTENTS: '1',
      VITE_STRK20_SHIELD_ALLOWED_TOKENS: [
        STRK_TOKEN,
        '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7',
        '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb',
        '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8',
        '0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac',
      ].join(','),
    }],
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

  it('pins the inlined xSTRK felt to the privacy package constant', async () => {
    const { XSTRK_TOKEN } = await import('./config.js');
    const { ENDUR_XSTRK } = await import('@strkworld/privacy');
    expect(BigInt(XSTRK_TOKEN)).toBe(BigInt(ENDUR_XSTRK));
    expect(XSTRK_TOKEN).toBe(XSTRK);
  });

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
