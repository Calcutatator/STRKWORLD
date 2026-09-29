import { shortString } from 'starknet';
import { describe, expect, it } from 'vitest';
import {
  SHADOW_ACCOUNT_ANONYMIZER,
  SHADOW_ACCOUNT_PRIMER_CLASS_HASH,
  SHADOW_ACCOUNTS_WALLET_API,
  VAULT_DAPP_NAME,
  VAULT_SHADOW_NONCE,
  VESU_VSTRK,
  VESU_VSTRK_ASSET,
  VESU_VSTRK_DECIMALS,
  isContractAddress,
  shadowAccountAddress,
  vaultOutcomeFromReceipt,
  vaultRedeemActions,
  vaultSupplyActions,
} from './vault.js';

/**
 * The Vault's protocol constants and action builders (D-077), pinned against
 * the mainnet reads and the Vesu shadow-vault example
 * (github.com/starkience/starknet-shadow-vault-example, `src/lib/actions.ts`),
 * which runs the same Vesu calls through the canonical anonymizer.
 */

const SHADOW = '0x24d8f3e8df5b059df47354ec2153966aa055b901c2cf1f4ce0ba2b5e1b4a0e3';
const PLAYER = '0xabc';
const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const TX = '0x5eed';

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

  it('uses one fixed dapp name that fits a Cairo short string, and nonce 0', () => {
    expect(VAULT_DAPP_NAME).toBe('strkworld-vault');
    expect(VAULT_DAPP_NAME.length).toBeLessThanOrEqual(31);
    expect(/^[\x20-\x7E]+$/.test(VAULT_DAPP_NAME)).toBe(true);
    expect(shortString.decodeShortString(shortString.encodeShortString(VAULT_DAPP_NAME))).toBe(VAULT_DAPP_NAME);
    expect(VAULT_SHADOW_NONCE).toBe('0x0');
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
    expect(vaultSupplyActions({ shadowAccount: SHADOW, amount: 100n })).toEqual([
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
    const [withdraw, invoke] = vaultSupplyActions({ shadowAccount: SHADOW, amount });
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
    const [withdraw, invoke] = vaultSupplyActions({ shadowAccount: padded, amount: 1n });
    expect(withdraw).toMatchObject({ recipient: SHADOW });
    expect(invoke).toMatchObject({ calls: [{}, { calldata: ['0x1', '0x0', SHADOW] }] });
  });

  it.each([
    ['zero', '0x0'],
    ['2^251', `0x${(1n << 251n).toString(16)}`],
    ['not hex', 'shadow'],
  ])('refuses a %s shadow address', (_label, shadowAccount) => {
    expect(() => vaultSupplyActions({ shadowAccount, amount: 1n })).toThrow('Invalid Vault address.');
  });

  it.each([-1n, 1n << 256n])('refuses an amount outside u256: %s', (amount) => {
    expect(() => vaultSupplyActions({ shadowAccount: SHADOW, amount })).toThrow('Invalid Vault amount.');
  });
});

describe('vaultRedeemActions: an open note, then the vault call through the shadow account', () => {
  it('withdraws exact assets for a partial redeem, collecting only the gain', () => {
    expect(vaultRedeemActions({ shadowAccount: SHADOW, player: PLAYER, redeem: { assets: 100n } })).toEqual([
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
    expect(vaultRedeemActions({ shadowAccount: SHADOW, player: PLAYER, redeem: { shares: 0x21n } })).toEqual([
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
    const actions = vaultRedeemActions({ shadowAccount: SHADOW, player: PLAYER, redeem: { assets: 1n } });
    expect(actions.map((action) => action.type)).toEqual(['transfer', 'shadow_account_invoke']);
    expect(actions.filter((action) => action.type === 'transfer' && action.amount === 'OPEN')).toHaveLength(1);
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
