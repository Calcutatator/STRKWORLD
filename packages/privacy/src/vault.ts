import { hash, type STRK20_ACTION } from 'starknet';
import type { VaultOutcome } from './operations.js';
import type { Address } from './types.js';
import { VESU_MARKET_ROWS } from './vesu-markets.js';

/**
 * The Vault: Vesu lending from the player's STRK20 shadow account (D-077),
 * in every token D-079 and D-081 pin a vault for.
 *
 * Protocol constants, not configuration, like `endur.ts`. The shell never
 * supplies a target, selector or calldata (D-018): this package pins the one
 * anonymizer, the token → vault map (`VAULT_MARKETS`) and the dapp name, and
 * builds every action from them. The backend pins the same vaults
 * independently for its reads. Mainnet only (D-001).
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
 * Vesu's Prime pool (a V2 pool, listed in Vesu's contract addresses): Vesu's
 * own pool, and the one a market uses whenever it lists the token (D-081).
 * Read on mainnet at block 15,669,141, 2026-09-30 (D-079).
 */
export const VESU_PRIME_POOL =
  '0x0451fe483d5921a2919ddd81d0de6696669bccdacd859f72a4fba7656b97c3b5';

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

/** vSTRK's `asset()`: canonical STRK, the pool's fee token. */
export const VESU_VSTRK_ASSET =
  '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

/** vSTRK's `decimals()`. */
export const VESU_VSTRK_DECIMALS = 18;

/**
 * The one class every pinned vault runs (Vesu's V2 vToken, and the
 * PoolFactory's own `v_token_class_hash()`), so the entry points the Vault
 * calls have one shape across tokens and pools. Read with
 * `starknet_getClassHashAt` for each vault (D-079, D-081).
 */
export const VESU_VTOKEN_CLASS_HASH =
  '0x41b16e0ca0565a58d1379ffc3c7eab7459b382ba8f8208b3b87d18d2aed4f78';

/**
 * The most markets the Vault may pin, and so the longest Vault allowlist a
 * build may name (D-081): more than this is a mistake, not a policy.
 */
export const MAX_VAULT_MARKETS = 48;

/** Whether a market's pool is Vesu's own Prime pool or one a third-party curator runs, with its own risk settings. */
export type VaultPoolCuration = 'prime' | 'curated';

/**
 * A token the Vault lends, and the one Vesu vault it lends it to (D-079,
 * D-081). A market is one asset in one Vesu pool, the unit Vesu itself calls
 * a lending market, so a borrow can name the same pool and token later.
 */
export interface VaultMarket {
  /** The vault's ERC-4626 `asset()`: the token supplied, and paid back on a redeem. */
  readonly token: Address;
  /** The pool's vToken for that token. Its shares are the position. */
  readonly vault: Address;
  /** The Vesu pool the vault supplies into: its `pool_contract()`. */
  readonly pool: Address;
  /** The pool's own `pool_name()`, as its contract reports it. */
  readonly poolName: string;
  /** Prime, or a curated pool with its curator's own risk settings. */
  readonly curation: VaultPoolCuration;
  /**
   * Whether the pool lends this token out: Vesu's `canBeBorrowed`, the debt
   * asset of one of the pool's pairs, and a pair configured on the pool
   * contract, all three checked at generation (D-081). A collateral-only
   * market (`false`) pays no supply interest, so the Vault does not supply it
   * until borrowing ships; a position already in one still reads and redeems.
   */
  readonly lendable: boolean;
  /** The token's symbol and `decimals()`, as its contract reports them (USDC.e's symbol is Vesu's). */
  readonly symbol: string;
  readonly decimals: number;
}

/**
 * The token → vault map, in one place (D-079), for every Vesu lending market
 * whose token can sit in a STRK20 private balance (D-081). The rows are
 * generated by `scripts/vesu-markets.mjs`, which derives them from Vesu's
 * public API and verifies each on mainnet: the vault is the PoolFactory's own
 * for its pool and token both ways, its `asset()` is the token, its
 * `pool_contract()` the pool, its class `VESU_VTOKEN_CLASS_HASH` (or an ABI
 * with every entry point the builders call, in their shapes), the pool's
 * `pool_name()` its name and not paused, and the token an ordinary ERC-20
 * whose `decimals()` and `symbol()` match: any such token can sit in a STRK20
 * private balance, since the pool keeps no token list. Each token uses
 * Prime's vault when Prime lists it, and otherwise a curated pool the
 * generator's policy approves by address (Re7 xBTC for every BTC token it
 * lists, as the lead chose for strkBTC). `lendable` marks the markets whose
 * pool lends the token out; the rest are collateral only. vTokens report 18
 * decimals whatever the token's own, so shares
 * are never shown: a position is its shares converted to the token by the
 * vault's own `preview_redeem`.
 *
 * STRK is D-077's vault, first. `config.test.ts` (the web's admission list),
 * the backend's `vault.test.ts` (its read list) and
 * `scripts/vesu-markets.test.mjs` (all three, rendered from one list) pin
 * their copies to this map, token for token.
 */
export const VAULT_MARKETS: readonly VaultMarket[] = Object.freeze(
  VESU_MARKET_ROWS.map((row) => Object.freeze({
    token: row.token,
    vault: row.vault,
    pool: row.pool,
    poolName: row.poolName,
    curation: row.curation,
    lendable: row.lendable,
    symbol: row.symbol,
    decimals: row.decimals,
  })),
);

/**
 * The pinned market for `token`, compared by field value, or undefined for a
 * token the Vault does not lend.
 */
export function vaultMarket(token: unknown): VaultMarket | undefined {
  if (typeof token !== 'string' || !isContractAddress(token)) return undefined;
  const value = BigInt(token);
  return VAULT_MARKETS.find((market) => BigInt(market.token) === value);
}

/**
 * The Vault's `dapp_name`, a Cairo short string the wallet hashes into the
 * shadow account's commitment. It is part of every player's stand-in address:
 * changing it moves every Vault position to an address nothing here reads, so
 * it is fixed for good (D-077).
 */
export const VAULT_DAPP_NAME = 'strkworld-vault';

/**
 * The one shadow account per player the Vault uses (D-077). Every token's
 * position, in every pool, sits on it (D-079, D-081), so they are linked to
 * each other on-chain.
 */
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
 * a nonce (the Vault's, 0, unless told otherwise), derived as the anonymizer
 * derives it. The anonymizer's view is the authority; this is the
 * independent check that a relay or a node cannot redirect a withdraw leg to
 * an address of its choosing. The borrow counter's account (D-083) and
 * Endur unstaking's (D-085) are different partial commitments, for their own
 * dapp names, at the same nonce.
 */
export function shadowAccountAddress(partialCommitment: string, nonce: string = VAULT_SHADOW_NONCE): Address {
  const commitment = hash.computePoseidonHashOnElements([partialCommitment, nonce]);
  return hash.calculateContractAddressFromHash(
    commitment,
    SHADOW_ACCOUNT_PRIMER_CLASS_HASH,
    [],
    SHADOW_ACCOUNT_ANONYMIZER,
  );
}

/**
 * The supply the wallet proves (D-077), in the shape the Vesu shadow-vault
 * example runs on mainnet, for any pinned market in any pool (D-079, D-081):
 *
 * 1. withdraw `amount` of the market's token from the pool to the shadow
 *    account: the public leg;
 * 2. through the shadow account, approve the market's vault for `amount`,
 *    then deposit it with the shadow account as receiver, so the shares stay
 *    there;
 * 3. collect nothing (`exact 0`): the shares are the position, and no open
 *    note is created to fill.
 */
export function vaultSupplyActions(input: { market: VaultMarket; shadowAccount: Address; amount: bigint }): STRK20_ACTION[] {
  const market = pinnedMarket(input.market);
  const amount = u256Felts(input.amount);
  const shadow = canonicalAddress(input.shadowAccount);
  return [
    { type: 'withdraw', token: market.token, amount: toFelt(input.amount), recipient: shadow },
    {
      type: 'shadow_account_invoke',
      dapp_name: VAULT_DAPP_NAME,
      nonce: VAULT_SHADOW_NONCE,
      calls: [
        { contractAddress: market.token, entrypoint: 'approve', calldata: [market.vault, ...amount] },
        { contractAddress: market.vault, entrypoint: 'deposit', calldata: [...amount, shadow] },
      ],
      collect_policy: { type: 'exact', amount: '0x0' },
    },
  ];
}

/**
 * The redeem the wallet proves (D-077), for any pinned market in any pool
 * (D-079, D-081):
 *
 * 1. open one note of the market's token for the player, which the invoke
 *    fills;
 * 2. through the shadow account, `withdraw(assets)` for a partial redeem or
 *    `redeem(shares)` for all of it, the shadow account as receiver and
 *    owner;
 * 3. collect only what this interaction gained (`diff`), so a public balance
 *    of that token the shadow account already held stays where it is.
 */
export function vaultRedeemActions(input: {
  market: VaultMarket;
  shadowAccount: Address;
  player: Address;
  redeem: { readonly assets: bigint } | { readonly shares: bigint };
}): STRK20_ACTION[] {
  const market = pinnedMarket(input.market);
  const shadow = canonicalAddress(input.shadowAccount);
  const byShares = 'shares' in input.redeem;
  const value = 'shares' in input.redeem ? input.redeem.shares : input.redeem.assets;
  return [
    { type: 'transfer', token: market.token, amount: 'OPEN', recipient: input.player },
    {
      type: 'shadow_account_invoke',
      dapp_name: VAULT_DAPP_NAME,
      nonce: VAULT_SHADOW_NONCE,
      calls: [
        {
          contractAddress: market.vault,
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

/**
 * The pinned entry a market names, token and vault both, or a throw: an
 * action is never built against a vault this file does not pin.
 */
function pinnedMarket(market: unknown): VaultMarket {
  const token = ownData(market, 'token');
  const vault = ownData(market, 'vault');
  const pinned = vaultMarket(token);
  if (!pinned || typeof vault !== 'string' || !isContractAddress(vault) || BigInt(vault) !== BigInt(pinned.vault)) {
    throw new Error('Invalid Vault market.');
  }
  return pinned;
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
function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
