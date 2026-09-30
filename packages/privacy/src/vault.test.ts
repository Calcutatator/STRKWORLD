import { shortString } from 'starknet';
import { describe, expect, it } from 'vitest';
import type { STRK20_ACTION } from 'starknet';
import {
  MAX_VAULT_MARKETS,
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

const PRIME = VESU_PRIME_POOL;
/** Re7 xBTC: the BTC-focused curated pool the lead chose for strkBTC (D-081). */
const RE7_XBTC = '0x03a8416bf20d036df5b1cf3447630a2e1cb04685f6b0c3a70ed7fb1473548ecf';
const RE7_ECOSYSTEM = '0x0486294fe74daf3d964523e7a1f4e5d686f153934b2c183ececa0cab9dd2f3e6';

/**
 * The vaults, as `scripts/vesu-markets.mjs` verified them on mainnet at block
 * 15,680,638 on 2026-09-30 (D-081): each vault is the PoolFactory's own for its
 * pool and token, its `asset()` the token beside it and its `pool_contract()`
 * the pool beside it; the decimals are the token's own. D-079's five keep their
 * vaults. Order: the counter's groups, then the order within each.
 */
const READ_ON_MAINNET = [
  ['STRK', STRK, VESU_VSTRK, PRIME, 18],
  ['ETH', '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7', '0x006ac248c18c69e57573aa3eeccbb7f8cd29e3024561be252ee7b34b96c1043e', PRIME, 18],
  ['USDC', '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb', '0x00387e8ddbb1ab36ca08874d9abc702ef4872ad600dcf76b7f240b71d7bc4e65', PRIME, 6],
  ['USDT', '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8', '0x06be9f8980779930045b93c295105c6810d38191ec522b5175ddf7dbf9b22f9d', PRIME, 6],
  ['USDC.e', '0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8', '0x00079c83c3eb20df05d9e3ebdd45990060101bd126666181de622e432948f3e9', PRIME, 6],
  ['WBTC', '0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac', '0x04ecb0667140b9f45b067d026953ed79f22723f1cfac05a7b26c3ac06c88f56c', PRIME, 8],
  ['strkBTC', '0x0787150e306e6eae6e3f79dea881770e8bbff2c1b8eb490f969669ee945b3135', '0x04269987e8971bc613be4f8161e04a4d2652f5e6ade9aa3f2820b1fc3f7ef848', RE7_XBTC, 8],
  ['tBTC', '0x04daa17763b286d1e59b97c283c0b8c949994c361e426a28f743c67bdfe9a32f', '0x04cbe8b13ebadd744254b09a40f4395f580e8a4a30acb2653849f61d12bfa039', RE7_XBTC, 18],
  ['SolvBTC', '0x0593e034dda23eea82d2ba9a30960ed42cf4a01502cc2351dc9b9881f9931a68', '0x0590117befc944f23b39ca5b0401e6aaa7834e90f2eb284baa2bfc475bd66190', RE7_XBTC, 18],
  ['xSTRK', '0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a', '0x073f369a935c8d8c9c793b371c5d384988060a96e7b11fb1dd2e5718d34639ad', PRIME, 18],
  ['wstETH', '0x0057912720381af14b0e5c87aa4718ed5e527eab60b3801ebf702ab09139e38b', '0x07d231447ac838f45740ed823c3ae0982d94377bc9f165f751a371a41e9c1740', PRIME, 18],
  ['xWBTC', '0x06a567e68c805323525fe1649adb80b03cddf92c23d2629a6779f54192dffc13', '0x00beb129889ac800bb84a8d31dfaa39c8710ee8f6310386ee03a37e79e6d7e1f', PRIME, 8],
  ['xstrkBTC', '0x047751b3532fabca89b0f2e35ca1cb45e5a7b11d5e3d3663dfa1f4406b45fd88', '0x01196b589bbc3379aa43bbba6ac40e89766d7e5242b098f47e587f2afc577c7a', RE7_XBTC, 8],
  ['xtBTC', '0x043a35c1425a0125ef8c171f1a75c6f31ef8648edcc8324b55ce1917db3f9b91', '0x03d90538d9b66c7fa3e582e7af5e96018a4f8f1e43d5eace23ba820fbe06ff70', RE7_XBTC, 18],
  ['LBTC', '0x036834a40984312f7f7de8d31e3f6305b325389eaeea5b1c0664b2fb936461a4', '0x073476ed5b0d781182ede4c806241a93cb47cb00b6de354855a1fc6233a13b35', RE7_XBTC, 8],
  ['EKUBO', '0x075afe6402ad5a5c20dd25e10ec3b3986acaa647b77e4ae24b0cbc9a54a27a87', '0x04fcf9064c23d146f6921b3fd9301bbec6384b37b87c173809a79f91b4d46fc4', RE7_ECOSYSTEM, 18],
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

describe('VAULT_MARKETS: the token → vault map (D-079, D-081)', () => {
  it('pins exactly the sixteen vaults verified on mainnet, STRK first, frozen', () => {
    expect(VAULT_MARKETS.map((market) => [market.symbol, market.token, market.vault, market.pool, market.decimals])).toEqual(READ_ON_MAINNET);
    expect(Object.isFrozen(VAULT_MARKETS)).toBe(true);
    for (const market of VAULT_MARKETS) expect(Object.isFrozen(market), market.symbol).toBe(true);
    expect(VAULT_MARKETS.length).toBeLessThanOrEqual(MAX_VAULT_MARKETS);
    expect(MAX_VAULT_MARKETS).toBe(48);
  });

  it('keeps D-077’s vSTRK as the STRK market, unchanged, in Prime', () => {
    expect(STRK_MARKET).toEqual({
      token: VESU_VSTRK_ASSET,
      vault: VESU_VSTRK,
      pool: VESU_PRIME_POOL,
      poolName: 'Prime',
      curation: 'prime',
      symbol: 'STRK',
      decimals: VESU_VSTRK_DECIMALS,
    });
  });

  it('keeps D-079’s five vaults where they were', () => {
    const five = ['STRK', 'ETH', 'USDC', 'USDT', 'WBTC'].map((symbol) => VAULT_MARKETS.find((market) => market.symbol === symbol)!);
    expect(five.map((market) => [market.vault, market.pool])).toEqual([
      [VESU_VSTRK, PRIME],
      ['0x006ac248c18c69e57573aa3eeccbb7f8cd29e3024561be252ee7b34b96c1043e', PRIME],
      ['0x00387e8ddbb1ab36ca08874d9abc702ef4872ad600dcf76b7f240b71d7bc4e65', PRIME],
      ['0x06be9f8980779930045b93c295105c6810d38191ec522b5175ddf7dbf9b22f9d', PRIME],
      ['0x04ecb0667140b9f45b067d026953ed79f22723f1cfac05a7b26c3ac06c88f56c', PRIME],
    ]);
  });

  it('lends each token through one vault and each vault for one token', () => {
    const tokens = new Set(VAULT_MARKETS.map((market) => BigInt(market.token)));
    const vaults = new Set(VAULT_MARKETS.map((market) => BigInt(market.vault)));
    const symbols = new Set(VAULT_MARKETS.map((market) => market.symbol));
    expect(tokens.size).toBe(VAULT_MARKETS.length);
    expect(vaults.size).toBe(VAULT_MARKETS.length);
    expect(symbols.size).toBe(VAULT_MARKETS.length);
    for (const market of VAULT_MARKETS) {
      expect(isContractAddress(market.token), market.symbol).toBe(true);
      expect(isContractAddress(market.vault), market.symbol).toBe(true);
      expect(isContractAddress(market.pool), market.symbol).toBe(true);
      expect(tokens.has(BigInt(market.vault)), market.symbol).toBe(false);
    }
  });

  it('marks Prime as Prime and every other pool as curated, by the pool’s own name', () => {
    for (const market of VAULT_MARKETS) {
      const prime = BigInt(market.pool) === BigInt(VESU_PRIME_POOL);
      expect(market.curation, market.symbol).toBe(prime ? 'prime' : 'curated');
      expect(market.poolName, market.symbol).toBe(prime ? 'Prime' : BigInt(market.pool) === BigInt(RE7_XBTC) ? 'Re7 xBTC' : 'Re7 Labs Starknet Ecosystem');
    }
  });

  it('lends strkBTC through Re7 xBTC, the curated pool the lead chose, since Prime lists none (D-081)', () => {
    const strkBtc = vaultMarket('0x0787150e306e6eae6e3f79dea881770e8bbff2c1b8eb490f969669ee945b3135');
    expect(strkBtc).toMatchObject({ symbol: 'strkBTC', pool: RE7_XBTC, poolName: 'Re7 xBTC', curation: 'curated', decimals: 8 });
    // The bridged USDC.e is its own market, in Prime, beside Circle's USDC.
    expect(vaultMarket('0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8')).toMatchObject({ symbol: 'USDC.e', curation: 'prime' });
  });

  it('leaves out Vesu’s tokens the STRK20 pool has never held (D-081)', () => {
    for (const token of [
      '0x02411565ef1a14decfbe83d2e987cced918cd752508a3d9c55deb67148d14d17', // sUSN
      '0x023a312ece4a275e38c9fc169e3be7b5613a0cb55fe1bece4422b09a88434573', // uniBTC
      '0x04e4fb1a9ca7e84bae609b9dc0078ad7719e49187ae7e425bb47d131710eddac', // mRe7BTC
    ]) {
      expect(vaultMarket(token), token).toBeUndefined();
    }
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
