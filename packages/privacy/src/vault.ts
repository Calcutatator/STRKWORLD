import { hash, type STRK20_ACTION } from 'starknet';
import type { VaultOutcome } from './operations.js';
import type { Address } from './types.js';

/**
 * The Vault: Vesu lending from the player's STRK20 shadow account (D-077).
 *
 * Protocol constants, not configuration, like `endur.ts`. The shell never
 * supplies a target, selector or calldata (D-018): this package pins the one
 * anonymizer, the one vault and the one token the Vault admits, and builds
 * every action from them. The backend pins the same contracts independently
 * for its two reads. Mainnet only (D-001).
 *
 * A shadow account is a keyless, deterministic address per (player,
 * `dapp_name`, nonce) that only the canonical anonymizer can execute through.
 * Its balances, calls and positions are public; the protocol flow hides only
 * which wallet controls it.
 */

/**
 * The canonical `ShadowAccountAnonymizer`, StarkWare's deployment. Its
 * `get_privacy_contract()` is the STRK20 pool (`STRK20_POOL`). Read from the
 * deployed class (class hash
 * `0xb61dee4f9f6b243f5310fbfab4224128db5c4815077b6329c232f8fc9af409`) over
 * mainnet RPC at block 15,636,298, 2026-09-29; see D-077.
 */
export const SHADOW_ACCOUNT_ANONYMIZER =
  '0x04f33230dc57855c6e7eabe66dfa0fde82c5458fd0e54827cdb7cb4c474888a7';

/**
 * The class a shadow account is first deployed with, which fixes its
 * address: `calculateContractAddressFromHash(poseidon(partial, nonce),
 * PRIMER, [], anonymizer)`. Not `get_shadow_account_class_hash()`, which is
 * the class installed afterwards; the starknet.js 10.8.0 guide derives with
 * that one and gets a different address. Declared on mainnet, and matched
 * against the anonymizer's own `get_shadow_accounts` view for three
 * commitments at block 15,636,298, 2026-09-29; see D-077.
 */
export const SHADOW_ACCOUNT_PRIMER_CLASS_HASH =
  '0x00123e6bc1c14ae9934e933d3f64916a6116dd6b036a922b2b1f0815e0d1d300';

/**
 * Vesu's vSTRK vault in its Prime pool: "Vesu Starknet", ERC-4626 over STRK.
 * `deposit(assets: u256, receiver)`, `withdraw(assets: u256, receiver,
 * owner)` and `redeem(shares: u256, receiver, owner)`. Read from the
 * deployed contract (class hash
 * `0x41b16e0ca0565a58d1379ffc3c7eab7459b382ba8f8208b3b87d18d2aed4f78`) over
 * mainnet RPC at block 15,636,298, 2026-09-29; see D-077.
 */
export const VESU_VSTRK =
  '0x06d6d2bf905dd199c78f2e421521d8473042737be9f47904e7578536c10f279d';

/** vSTRK's `asset()`: STRK, the only token the Vault lends in v1. */
export const VESU_VSTRK_ASSET =
  '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

/** vSTRK's `decimals()`. */
export const VESU_VSTRK_DECIMALS = 18;

/**
 * The Vault's `dapp_name`, a Cairo short string the wallet hashes into the
 * shadow account's commitment. It is part of every player's stand-in address:
 * changing it moves every Vault position to an address nothing here reads, so
 * it is fixed for good (D-077).
 */
export const VAULT_DAPP_NAME = 'strkworld-vault';

/** The one shadow account per player the Vault uses (D-077). */
export const VAULT_SHADOW_NONCE = '0x0';

/** The Wallet API release that added shadow accounts. */
export const SHADOW_ACCOUNTS_WALLET_API = '0.10.4';

const U128_MASK = (1n << 128n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
/** Starknet contract addresses lie below 2^251. */
const CONTRACT_ADDRESS_BOUND = 1n << 251n;
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

/**
 * Where the anonymizer puts the shadow account for a partial commitment at
 * the Vault's nonce, derived as the anonymizer derives it. The anonymizer's
 * view is the authority; this is the independent check that a relay or a
 * node cannot redirect the Vault's withdraw leg to an address of its choosing.
 */
export function shadowAccountAddress(partialCommitment: string): Address {
  const commitment = hash.computePoseidonHashOnElements([partialCommitment, VAULT_SHADOW_NONCE]);
  return hash.calculateContractAddressFromHash(
    commitment,
    SHADOW_ACCOUNT_PRIMER_CLASS_HASH,
    [],
    SHADOW_ACCOUNT_ANONYMIZER,
  );
}

/**
 * The supply the wallet proves (D-077), in the shape the Vesu shadow-vault
 * example runs on mainnet:
 *
 * 1. withdraw `amount` from the pool to the shadow account: the public leg;
 * 2. through the shadow account, approve vSTRK for `amount`, then deposit it
 *    with the shadow account as receiver, so the shares stay there;
 * 3. collect nothing (`exact 0`): the shares are the position, and no open
 *    note is created to fill.
 */
export function vaultSupplyActions(input: { shadowAccount: Address; amount: bigint }): STRK20_ACTION[] {
  const amount = u256Felts(input.amount);
  const shadow = canonicalAddress(input.shadowAccount);
  return [
    { type: 'withdraw', token: VESU_VSTRK_ASSET, amount: toFelt(input.amount), recipient: shadow },
    {
      type: 'shadow_account_invoke',
      dapp_name: VAULT_DAPP_NAME,
      nonce: VAULT_SHADOW_NONCE,
      calls: [
        { contractAddress: VESU_VSTRK_ASSET, entrypoint: 'approve', calldata: [VESU_VSTRK, ...amount] },
        { contractAddress: VESU_VSTRK, entrypoint: 'deposit', calldata: [...amount, shadow] },
      ],
      collect_policy: { type: 'exact', amount: '0x0' },
    },
  ];
}

/**
 * The redeem the wallet proves (D-077):
 *
 * 1. open one STRK note for the player, which the invoke fills;
 * 2. through the shadow account, `withdraw(assets)` for a partial redeem or
 *    `redeem(shares)` for all of it, the shadow account as receiver and
 *    owner;
 * 3. collect only what this interaction gained (`diff`), so a public STRK
 *    balance the shadow account already held stays where it is.
 */
export function vaultRedeemActions(input: {
  shadowAccount: Address;
  player: Address;
  redeem: { readonly assets: bigint } | { readonly shares: bigint };
}): STRK20_ACTION[] {
  const shadow = canonicalAddress(input.shadowAccount);
  const byShares = 'shares' in input.redeem;
  const value = 'shares' in input.redeem ? input.redeem.shares : input.redeem.assets;
  return [
    { type: 'transfer', token: VESU_VSTRK_ASSET, amount: 'OPEN', recipient: input.player },
    {
      type: 'shadow_account_invoke',
      dapp_name: VAULT_DAPP_NAME,
      nonce: VAULT_SHADOW_NONCE,
      calls: [
        {
          contractAddress: VESU_VSTRK,
          entrypoint: byShares ? 'redeem' : 'withdraw',
          calldata: [...u256Felts(value), shadow, shadow],
        },
      ],
      collect_policy: { type: 'diff' },
    },
  ];
}

/**
 * What a Vault transaction's receipt says. `succeeded` and `reverted` need
 * this transaction's own receipt with an accepted finality; anything else,
 * including a missing, malformed or hostile receipt or one for another
 * transaction, is `pending`, never a failure.
 */
export function vaultOutcomeFromReceipt(receipt: unknown, transactionHash: string): VaultOutcome {
  try {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return 'pending';
    if (!sameFelt(ownData(receipt, 'transaction_hash'), transactionHash)) return 'pending';
    const finality = ownData(receipt, 'finality_status');
    if (finality !== 'ACCEPTED_ON_L2' && finality !== 'ACCEPTED_ON_L1') return 'pending';
    const execution = ownData(receipt, 'execution_status');
    if (execution === 'SUCCEEDED') return 'succeeded';
    if (execution === 'REVERTED') return 'reverted';
    return 'pending';
  } catch {
    return 'pending';
  }
}

/** A Starknet contract address: a felt above zero and below 2^251. */
export function isContractAddress(value: unknown): value is Address {
  return typeof value === 'string' && isFelt(value) && BigInt(value) > 0n && BigInt(value) < CONTRACT_ADDRESS_BOUND;
}

/** `0x` and lowercase hex without padding: one spelling per address. */
function canonicalAddress(address: Address): Address {
  if (!isContractAddress(address)) throw new Error('Invalid Vault address.');
  return toFelt(BigInt(address));
}

/** Cairo serializes a u256 as two felts, low 128 bits first. */
function u256Felts(value: bigint): [string, string] {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_UINT256) throw new Error('Invalid Vault amount.');
  return [toFelt(value & U128_MASK), toFelt(value >> 128n)];
}

function toFelt(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function isFelt(value: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(value) && BigInt(value) < STARK_FIELD_PRIME;
}

function sameFelt(value: unknown, expected: string): boolean {
  return typeof value === 'string' && isFelt(value) && typeof expected === 'string' && isFelt(expected)
    && BigInt(value) === BigInt(expected);
}

/** An own data property, never a getter or an inherited value. */
function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
