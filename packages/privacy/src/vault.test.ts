import { shortString } from 'starknet';
import { describe, expect, it } from 'vitest';
import type { STRK20_ACTION } from 'starknet';
import {
  SHADOW_ACCOUNT_ANONYMIZER,
  SHADOW_ACCOUNT_PRIMER_CLASS_HASH,
  SHADOW_ACCOUNTS_WALLET_API,
  VAULT_DAPP_NAME,
  VAULT_MARKETS,
  VAULT_SHADOW_NONCE,
  VESU_PRIME_POOL,
  VESU_VSTRK,
  VESU_VSTRK_ASSET,
  VESU_VSTRK_DECIMALS,
  VESU_VTOKEN_CLASS_HASH,
  isContractAddress,
  shadowAccountAddress,
  vaultMarket,
  vaultOutcomeFromReceipt,
  vaultRedeemActions,
  vaultSupplyActions,
  type VaultMarket,
} from './vault.js';

/**
 * The Vault's protocol constants and action builders (D-077, D-079), pinned
 * against the mainnet reads and the Vesu shadow-vault example
 * (github.com/starkience/starknet-shadow-vault-example, `src/lib/actions.ts`),
 * which runs the same Vesu calls through the canonical anonymizer.
 */

const SHADOW = '0x24d8f3e8df5b059df47354ec2153966aa055b901c2cf1f4ce0ba2b5e1b4a0e3';
const PLAYER = '0xabc';
const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const TX = '0x5eed';
const STRK_MARKET = VAULT_MARKETS[0]!;

/**
 * The vaults, as read over mainnet RPC at block 15,669,141 on 2026-09-30
 * (D-079): each vault's `asset()` is the token beside it, and its
 * `pool_contract()` the Prime pool; the decimals are the token's own.
 */
const READ_ON_MAINNET = [
  ['STRK', STRK, VESU_VSTRK, 18],
  ['ETH', '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7', '0x006ac248c18c69e57573aa3eeccbb7f8cd29e3024561be252ee7b34b96c1043e', 18],
  ['USDC', '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb', '0x00387e8ddbb1ab36ca08874d9abc702ef4872ad600dcf76b7f240b71d7bc4e65', 6],
  ['USDT', '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8', '0x06be9f8980779930045b93c295105c6810d38191ec522b5175ddf7dbf9b22f9d', 6],
  ['WBTC', '0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac', '0x04ecb0667140b9f45b067d026953ed79f22723f1cfac05a7b26c3ac06c88f56c', 8],
] as const;

/**
 * vSTRK's supply, as D-077 pinned it against the example, with the token and
 * vault swapped for another market's: every market must build exactly this.
 */
function goldenSupply(market: VaultMarket, amount: string): STRK20_ACTION[] {
  return [
    { type: 'withdraw', token: market.token, amount, recipient: SHADOW },
    {
      type: 'shadow_account_invoke',
      dapp_name: 'strkworld-vault',
      nonce: '0x0',
      calls: [
        { contractAddress: market.token, entrypoint: 'approve', calldata: [market.vault, amount, '0x0'] },
        { contractAddress: market.vault, entrypoint: 'deposit', calldata: [amount, '0x0', SHADOW] },
      ],
      collect_policy: { type: 'exact', amount: '0x0' },
    },
  ];
}

function goldenRedeem(market: VaultMarket, entrypoint: 'withdraw' | 'redeem', value: string): STRK20_ACTION[] {
  return [
    { type: 'transfer', token: market.token, amount: 'OPEN', recipient: PLAYER },
    {
      type: 'shadow_account_invoke',
      dapp_name: 'strkworld-vault',
      nonce: '0x0',
      calls: [{ contractAddress: market.vault, entrypoint, calldata: [value, '0x0', SHADOW, SHADOW] }],
      collect_policy: { type: 'diff' },
    },
  ];
}

describe('Vault constants (D-077)', () => {
  it('pins the canonical anonymizer, Vesu vSTRK and its asset, as read on mainnet', () => {
    expect(SHADOW_ACCOUNT_ANONYMIZER).toBe('0x04f33230dc57855c6e7eabe66dfa0fde82c5458fd0e54827cdb7cb4c474888a7');
    expect(VESU_VSTRK).toBe('0x06d6d2bf905dd199c78f2e421521d8473042737be9f47904e7578536c10f279d');
    // vSTRK's `asset()` is canonical STRK, 18 decimals like vSTRK itself.
    expect(VESU_VSTRK_ASSET).toBe(STRK);
    expect(VESU_VSTRK_DECIMALS).toBe(18);
    expect(SHADOW_ACCOUNT_PRIMER_CLASS_HASH).toBe('0x00123e6bc1c14ae9934e933d3f64916a6116dd6b036a922b2b1f0815e0d1d300');
    expect(SHADOW_ACCOUNTS_WALLET_API).toBe('0.10.4');
  });

  it('pins the Prime pool and the one vToken class every vault runs', () => {
    expect(VESU_PRIME_POOL).toBe('0x0451fe483d5921a2919ddd81d0de6696669bccdacd859f72a4fba7656b97c3b5');
    expect(VESU_VTOKEN_CLASS_HASH).toBe('0x41b16e0ca0565a58d1379ffc3c7eab7459b382ba8f8208b3b87d18d2aed4f78');
  });

  it('uses one fixed dapp name that fits a Cairo short string, and nonce 0', () => {
    expect(VAULT_DAPP_NAME).toBe('strkworld-vault');
    expect(VAULT_DAPP_NAME.length).toBeLessThanOrEqual(31);
    expect(/^[\x20-\x7E]+$/.test(VAULT_DAPP_NAME)).toBe(true);
    expect(shortString.decodeShortString(shortString.encodeShortString(VAULT_DAPP_NAME))).toBe(VAULT_DAPP_NAME);
    expect(VAULT_SHADOW_NONCE).toBe('0x0');
  });
});

describe('VAULT_MARKETS: the token → vault map (D-079)', () => {
  it('pins exactly the five vaults read on mainnet, STRK first, frozen', () => {
    expect(VAULT_MARKETS.map((market) => [market.symbol, market.token, market.vault, market.decimals])).toEqual(READ_ON_MAINNET);
    expect(Object.isFrozen(VAULT_MARKETS)).toBe(true);
    for (const market of VAULT_MARKETS) expect(Object.isFrozen(market), market.symbol).toBe(true);
  });

  it('keeps D-077’s vSTRK as the STRK market, unchanged', () => {
    expect(STRK_MARKET).toEqual({ token: VESU_VSTRK_ASSET, vault: VESU_VSTRK, symbol: 'STRK', decimals: VESU_VSTRK_DECIMALS });
  });

  it('lends each token through one vault and each vault for one token', () => {
    const tokens = new Set(VAULT_MARKETS.map((market) => BigInt(market.token)));
    const vaults = new Set(VAULT_MARKETS.map((market) => BigInt(market.vault)));
    expect(tokens.size).toBe(VAULT_MARKETS.length);
    expect(vaults.size).toBe(VAULT_MARKETS.length);
    for (const market of VAULT_MARKETS) {
      expect(isContractAddress(market.token), market.symbol).toBe(true);
      expect(isContractAddress(market.vault), market.symbol).toBe(true);
      expect(tokens.has(BigInt(market.vault)), market.symbol).toBe(false);
    }
  });

  it('leaves strkBTC out: it has no vault in the Prime pool', () => {
    expect(vaultMarket('0x0787150e306e6eae6e3f79dea881770e8bbff2c1b8eb490f969669ee945b3135')).toBeUndefined();
    // Nor the bridged USDC.e, whose own Prime vault is a different contract.
    expect(vaultMarket('0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8')).toBeUndefined();
  });

  it('finds a market by the token’s field value, whatever its spelling', () => {
    const usdc = VAULT_MARKETS[2]!;
    expect(vaultMarket(usdc.token)).toBe(usdc);
    expect(vaultMarket(`0x${usdc.token.slice(3).toUpperCase()}`)).toBe(usdc);
    expect(vaultMarket(`0x${'0'.repeat(10)}${usdc.token.slice(2)}`)).toBeUndefined();
    for (const bad of [undefined, 42, '', '0x0', 'USDC', usdc.vault]) expect(vaultMarket(bad), String(bad)).toBeUndefined();
  });
});

describe('shadowAccountAddress: the anonymizer derivation, used only as a cross-check', () => {
  // Pairs read from the mainnet anonymizer's own `get_shadow_accounts(partial,
  // 0, 1, false)` on 2026-09-29 (block 15,641,579). The view is the authority;
  // this derivation must agree with it or the Vault refuses to send anything.
  it.each([
    ['0x123', '0x24d8f3e8df5b059df47354ec2153966aa055b901c2cf1f4ce0ba2b5e1b4a0e3'],
    ['0x7a5c0ffee', '0x329c10f147438cca6bb852e0a2089c669984624b8b358c7c8d23a341465834f'],
    ['0x5f2e1d', '0x24915cb456ef2876c9611af4f021747f8d9761ff2d7bc716722ce4527091ac9'],
  ])('derives the view’s nonce-0 address for partial commitment %s', (partial, address) => {
    expect(BigInt(shadowAccountAddress(partial))).toBe(BigInt(address));
  });
});

describe('vaultSupplyActions: withdraw to the shadow account, then approve and deposit through it', () => {
  it('builds the example’s deposit shape exactly', () => {
    expect(vaultSupplyActions({ market: STRK_MARKET, shadowAccount: SHADOW, amount: 100n })).toEqual([
      { type: 'withdraw', token: STRK, amount: '0x64', recipient: SHADOW },
      {
        type: 'shadow_account_invoke',
        dapp_name: 'strkworld-vault',
        nonce: '0x0',
        calls: [
          { contractAddress: STRK, entrypoint: 'approve', calldata: [VESU_VSTRK, '0x64', '0x0'] },
          { contractAddress: VESU_VSTRK, entrypoint: 'deposit', calldata: ['0x64', '0x0', SHADOW] },
        ],
        // The shares are the position: no open note, nothing collected.
        collect_policy: { type: 'exact', amount: '0x0' },
      },
    ]);
  });

  it('keeps the high limb of a u256 amount', () => {
    const amount = (1n << 128n) + 7n;
    const [withdraw, invoke] = vaultSupplyActions({ market: STRK_MARKET, shadowAccount: SHADOW, amount });
    expect(withdraw).toMatchObject({ amount: `0x${amount.toString(16)}` });
    expect(invoke).toMatchObject({
      calls: [
        { calldata: [VESU_VSTRK, '0x7', '0x1'] },
        { calldata: ['0x7', '0x1', SHADOW] },
      ],
    });
  });

  it('writes one spelling of the shadow address, whatever padding it arrived with', () => {
    const padded = `0x${'0'.repeat(64 - SHADOW.slice(2).length)}${SHADOW.slice(2).toUpperCase()}`;
    const [withdraw, invoke] = vaultSupplyActions({ market: STRK_MARKET, shadowAccount: padded, amount: 1n });
    expect(withdraw).toMatchObject({ recipient: SHADOW });
    expect(invoke).toMatchObject({ calls: [{}, { calldata: ['0x1', '0x0', SHADOW] }] });
  });

  it.each([
    ['zero', '0x0'],
    ['2^251', `0x${(1n << 251n).toString(16)}`],
    ['not hex', 'shadow'],
  ])('refuses a %s shadow address', (_label, shadowAccount) => {
    expect(() => vaultSupplyActions({ market: STRK_MARKET, shadowAccount, amount: 1n })).toThrow('Invalid Vault address.');
  });

  it.each([-1n, 1n << 256n])('refuses an amount outside u256: %s', (amount) => {
    expect(() => vaultSupplyActions({ market: STRK_MARKET, shadowAccount: SHADOW, amount })).toThrow('Invalid Vault amount.');
  });

  it.each(VAULT_MARKETS.map((market) => [market.symbol, market] as const))(
    'builds %s’s supply in vSTRK’s golden shape, with its own token and vault',
    (_symbol, market) => {
      expect(vaultSupplyActions({ market, shadowAccount: SHADOW, amount: 100n })).toEqual(goldenSupply(market, '0x64'));
    },
  );

  it('matches the vSTRK golden shape for STRK itself, so the generalisation changed nothing', () => {
    expect(goldenSupply(STRK_MARKET, '0x64')).toEqual([
      { type: 'withdraw', token: STRK, amount: '0x64', recipient: SHADOW },
      {
        type: 'shadow_account_invoke',
        dapp_name: 'strkworld-vault',
        nonce: '0x0',
        calls: [
          { contractAddress: STRK, entrypoint: 'approve', calldata: [VESU_VSTRK, '0x64', '0x0'] },
          { contractAddress: VESU_VSTRK, entrypoint: 'deposit', calldata: ['0x64', '0x0', SHADOW] },
        ],
        collect_policy: { type: 'exact', amount: '0x0' },
      },
    ]);
  });

  it.each([
    ['an unpinned token', { token: '0x123', vault: VESU_VSTRK, symbol: 'X', decimals: 18 }],
    ['a pinned token with another market’s vault', { ...STRK_MARKET, vault: VAULT_MARKETS[1]!.vault }],
    ['a pinned token with a vault nobody pinned', { ...STRK_MARKET, vault: '0x777' }],
    ['no vault', { token: STRK }],
    ['nothing', null],
  ])('refuses %s: nothing is built against a vault this file does not pin', (_label, market) => {
    expect(() => vaultSupplyActions({ market: market as never, shadowAccount: SHADOW, amount: 1n })).toThrow('Invalid Vault market.');
  });

  it('never runs a getter on the market it is handed', () => {
    let reads = 0;
    const market = Object.defineProperty({ token: STRK, symbol: 'STRK', decimals: 18 }, 'vault', {
      get() {
        reads += 1;
        return VESU_VSTRK;
      },
      enumerable: true,
    });
    expect(() => vaultSupplyActions({ market: market as never, shadowAccount: SHADOW, amount: 1n })).toThrow('Invalid Vault market.');
    expect(reads).toBe(0);
  });
});

describe('vaultRedeemActions: an open note, then the vault call through the shadow account', () => {
  it('withdraws exact assets for a partial redeem, collecting only the gain', () => {
    expect(vaultRedeemActions({ market: STRK_MARKET, shadowAccount: SHADOW, player: PLAYER, redeem: { assets: 100n } })).toEqual([
      { type: 'transfer', token: STRK, amount: 'OPEN', recipient: PLAYER },
      {
        type: 'shadow_account_invoke',
        dapp_name: 'strkworld-vault',
        nonce: '0x0',
        calls: [
          { contractAddress: VESU_VSTRK, entrypoint: 'withdraw', calldata: ['0x64', '0x0', SHADOW, SHADOW] },
        ],
        collect_policy: { type: 'diff' },
      },
    ]);
  });

  it('redeems every share for “all”, so no dust is left behind', () => {
    expect(vaultRedeemActions({ market: STRK_MARKET, shadowAccount: SHADOW, player: PLAYER, redeem: { shares: 0x21n } })).toEqual([
      { type: 'transfer', token: STRK, amount: 'OPEN', recipient: PLAYER },
      {
        type: 'shadow_account_invoke',
        dapp_name: 'strkworld-vault',
        nonce: '0x0',
        calls: [
          { contractAddress: VESU_VSTRK, entrypoint: 'redeem', calldata: ['0x21', '0x0', SHADOW, SHADOW] },
        ],
        collect_policy: { type: 'diff' },
      },
    ]);
  });

  it('opens exactly one note, the one the invoke fills, before the invoke', () => {
    const actions = vaultRedeemActions({ market: STRK_MARKET, shadowAccount: SHADOW, player: PLAYER, redeem: { assets: 1n } });
    expect(actions.map((action) => action.type)).toEqual(['transfer', 'shadow_account_invoke']);
    expect(actions.filter((action) => action.type === 'transfer' && action.amount === 'OPEN')).toHaveLength(1);
  });

  it.each(VAULT_MARKETS.map((market) => [market.symbol, market] as const))(
    'builds %s’s redeems in vSTRK’s golden shape: the open note in its token, the call on its vault',
    (_symbol, market) => {
      expect(vaultRedeemActions({ market, shadowAccount: SHADOW, player: PLAYER, redeem: { assets: 100n } }))
        .toEqual(goldenRedeem(market, 'withdraw', '0x64'));
      expect(vaultRedeemActions({ market, shadowAccount: SHADOW, player: PLAYER, redeem: { shares: 0x21n } }))
        .toEqual(goldenRedeem(market, 'redeem', '0x21'));
    },
  );

  it('refuses an unpinned market', () => {
    expect(() => vaultRedeemActions({
      market: { ...VAULT_MARKETS[2]!, vault: VESU_VSTRK },
      shadowAccount: SHADOW,
      player: PLAYER,
      redeem: { assets: 1n },
    })).toThrow('Invalid Vault market.');
  });
});

describe('vaultOutcomeFromReceipt', () => {
  const receipt = (fields: Record<string, unknown>) => ({ transaction_hash: TX, ...fields });

  it.each([
    ['succeeded on L2', receipt({ finality_status: 'ACCEPTED_ON_L2', execution_status: 'SUCCEEDED' }), 'succeeded'],
    ['succeeded on L1', receipt({ finality_status: 'ACCEPTED_ON_L1', execution_status: 'SUCCEEDED' }), 'succeeded'],
    ['reverted', receipt({ finality_status: 'ACCEPTED_ON_L2', execution_status: 'REVERTED' }), 'reverted'],
    ['pre-confirmed', receipt({ finality_status: 'PRE_CONFIRMED', execution_status: 'SUCCEEDED' }), 'pending'],
    ['unseen (null)', null, 'pending'],
    ['another transaction', { transaction_hash: '0x1', finality_status: 'ACCEPTED_ON_L2', execution_status: 'SUCCEEDED' }, 'pending'],
    ['a padded spelling of this one', receipt({ transaction_hash: '0x0000005eed', finality_status: 'ACCEPTED_ON_L2', execution_status: 'SUCCEEDED' }), 'succeeded'],
    ['no execution status', receipt({ finality_status: 'ACCEPTED_ON_L2' }), 'pending'],
    ['an array', [receipt({ finality_status: 'ACCEPTED_ON_L2', execution_status: 'SUCCEEDED' })], 'pending'],
  ] as const)('reads %s as %s', (_label, value, outcome) => {
    expect(vaultOutcomeFromReceipt(value, TX)).toBe(outcome);
  });

  it('never runs a getter on a hostile receipt', () => {
    let reads = 0;
    const hostile = Object.defineProperty({ transaction_hash: TX, finality_status: 'ACCEPTED_ON_L2' }, 'execution_status', {
      get() {
        reads += 1;
        return 'SUCCEEDED';
      },
      enumerable: true,
    });
    expect(vaultOutcomeFromReceipt(hostile, TX)).toBe('pending');
    expect(reads).toBe(0);
  });
});

describe('isContractAddress', () => {
  it.each([
    ['0x1', true],
    [SHADOW, true],
    ['0x0', false],
    [`0x${(1n << 251n).toString(16)}`, false],
    ['0x', false],
    [42, false],
  ] as const)('%s -> %s', (value, expected) => {
    expect(isContractAddress(value)).toBe(expected);
  });
});
