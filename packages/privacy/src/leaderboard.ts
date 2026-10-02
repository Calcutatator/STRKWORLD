import { hash, type STRK20_ACTION } from 'starknet';
import { PrivacyError, type Address } from './types.js';

/**
 * The private placement (leaderboard phase 1), as protocol data: receipts the
 * player's own account writes to STRKWORLD's `ReceiptLedger`, and the maths
 * that turns an anonymous histogram into "top 12%" on the player's device.
 *
 * - **Receipt mode** (shield, unshield, private send). The pool transaction
 *   carries one extra `shadow_account_invoke` for `LEADERBOARD_DAPP_NAME` at
 *   the player's next nonce, whose only call is `ledger.tick(C_n)`. Each
 *   receipt sits on a fresh single-use shadow account `C_n = h(p, n)`, so no
 *   outsider can link two of them; the player's wallet alone can produce the
 *   partial commitment `p` that enumerates them.
 * - **DeFi mode** (Vault, Borrow, Endur unstaking, Swap). The pool allows one
 *   external invoke per transaction and the feature's own shadow account
 *   holds it, so `ledger.tick(C_feature)` is appended to that shadow's calls.
 *   The feature shadow is persistent and already public, so the tick adds no
 *   link to the account.
 *
 * The ledger (`tick(commitment: felt252)`, `count_of(C)`, `root()`,
 * `leaf_count()`, `Receipt(C)` events) accepts a tick only from the genuine
 * canonical shadow account for `C` and counts each transaction hash once, so
 * one pool fee is at most one count. Its address is configuration
 * (`VITE_STRK20_LEADERBOARD_LEDGER`); with it unset nothing here is used.
 */

/** The season this build counts. A new season is a new dapp name, so its receipts never mix with the last. */
export const LEADERBOARD_SEASON = 's1';

/**
 * The receipts' `dapp_name`, a Cairo short string the wallet hashes into `p`.
 * Season-scoped on purpose: a tallier that ever held `p` can follow that
 * pseudonym for one season and no longer.
 */
export const LEADERBOARD_DAPP_NAME = 'strkworld-lb-s1';

/** `ReceiptLedger.tick(commitment: felt252)`. */
export const LEDGER_TICK_ENTRYPOINT = 'tick';
/** `ReceiptLedger.count_of(commitment: felt252)`. */
export const LEDGER_COUNT_OF_ENTRYPOINT = 'count_of';

/**
 * How many nonces one shadow read covers. Receipts are enumerated a page at a
 * time with `until_undeployed = false`, so a nonce left undeployed by a
 * reverted transaction (a gap) never hides the receipts after it.
 */
export const LEADERBOARD_SHADOW_PAGE = 128;
/** The most receipts one season counts for one player: eight pages. */
export const MAX_LEADERBOARD_RECEIPTS = 1_024;

const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const CONTRACT_ADDRESS_BOUND = 1n << 251n;

/**
 * The full commitment of the shadow account at `nonce` for a partial
 * commitment: `C = h(p, nonce)`, exactly as the canonical anonymizer salts the
 * account (`vault.ts` derives the address from the same value).
 */
export function shadowCommitment(partialCommitment: string, nonce: string | bigint): string {
  const n = typeof nonce === 'bigint' ? toFelt(nonce) : nonce;
  if (!isFelt(partialCommitment) || BigInt(partialCommitment) === 0n || !isFelt(n)) {
    throw new PrivacyError('unknown', 'Invalid shadow-account commitment input.');
  }
  return toFelt(BigInt(hash.computePoseidonHashOnElements([partialCommitment, n])));
}

/**
 * The receipt a shield, unshield or send carries: one shadow-account invoke at
 * the next nonce whose only call ticks the ledger, collecting nothing (no open
 * note is created, so nothing needs filling).
 */
export function receiptInvokeAction(input: { ledger: Address; partialCommitment: string; nonce: bigint }): STRK20_ACTION {
  const ledger = canonicalContract(input.ledger);
  if (typeof input.nonce !== 'bigint' || input.nonce < 0n || input.nonce >= BigInt(MAX_LEADERBOARD_RECEIPTS)) {
    throw new PrivacyError('unknown', 'Invalid receipt nonce.');
  }
  const commitment = shadowCommitment(input.partialCommitment, input.nonce);
  return {
    type: 'shadow_account_invoke',
    dapp_name: LEADERBOARD_DAPP_NAME,
    nonce: toFelt(input.nonce),
    calls: [{ contractAddress: ledger, entrypoint: LEDGER_TICK_ENTRYPOINT, calldata: [commitment] }],
    collect_policy: { type: 'exact', amount: '0x0' },
  };
}

/** Receipt mode: the reviewed actions with the receipt last, where Ready wants an invoke. */
export function withReceipt(actions: readonly STRK20_ACTION[], receipt: STRK20_ACTION): STRK20_ACTION[] {
  if (actions.some((action) => action.type === 'invoke' || action.type === 'shadow_account_invoke')) {
    // The pool allows one external invoke per transaction.
    throw new PrivacyError('unknown', 'A receipt cannot join a transaction that already invokes a contract.');
  }
  return [...actions, receipt];
}

/**
 * DeFi mode: the feature's actions with `ledger.tick(commitment)` appended to
 * its one shadow-account invoke's calls, after the feature's own calls. The
 * commitment must be that shadow's own (the ledger refuses any other caller).
 */
export function withLedgerTick(actions: readonly STRK20_ACTION[], ledger: Address, commitment: string): STRK20_ACTION[] {
  const target = canonicalContract(ledger);
  if (!isFelt(commitment) || BigInt(commitment) === 0n) {
    throw new PrivacyError('unknown', 'Invalid ledger commitment.');
  }
  const invokes = actions.filter((action) => action.type === 'shadow_account_invoke');
  if (invokes.length !== 1 || actions.some((action) => action.type === 'invoke')) {
    throw new PrivacyError('unknown', 'A ledger tick needs exactly one shadow-account invoke.');
  }
  return actions.map((action) => {
    if (action.type !== 'shadow_account_invoke') return action;
    return {
      ...action,
      calls: [
        ...action.calls,
        { contractAddress: target, entrypoint: LEDGER_TICK_ENTRYPOINT, calldata: [toFelt(BigInt(commitment))] },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// Placement, computed on the player's device
// ---------------------------------------------------------------------------

/** One bar of the season's anonymous histogram: how many checked-in players have exactly `count` receipts. */
export interface LeaderboardBucket {
  readonly count: number;
  readonly players: number;
}

/** The season's anonymous histogram, counts only: no hash, no time, nothing per player. */
export interface LeaderboardHistogram {
  readonly season: string;
  /** Checked-in players with at least one receipt. */
  readonly total: number;
  readonly buckets: readonly LeaderboardBucket[];
}

export interface Placement {
  /** 1 + the players with strictly more receipts: ties share a rank. */
  readonly rank: number;
  /** Players ranked, the viewer included. */
  readonly total: number;
  /** "Top N%": the rank as a share of everyone ranked, rounded up, at least 1. */
  readonly topPercent: number;
}

/**
 * Where `count` sits in the histogram. `included` says the player's own entry
 * is already in it (their check-in was stored); otherwise they are added as
 * one more player. Zero receipts is not a placement.
 */
export function placementFrom(histogram: LeaderboardHistogram, count: number, included: boolean): Placement | null {
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  let above = 0;
  let total = 0;
  for (const bucket of histogram.buckets) {
    total += bucket.players;
    if (bucket.count > count) above += bucket.players;
  }
  if (!included) total += 1;
  if (total <= 0) return null;
  const rank = above + 1;
  const topPercent = Math.min(100, Math.max(1, Math.ceil((rank / total) * 100)));
  return Object.freeze({ rank, total, topPercent });
}

/** Read a histogram strictly; anything malformed is null, never a number to rank against. */
export function ownHistogram(value: unknown): LeaderboardHistogram | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const season = ownData(value, 'season');
    const total = ownData(value, 'total');
    const buckets = ownData(value, 'buckets');
    if (typeof season !== 'string' || season.length === 0 || season.length > 16) return null;
    if (!Number.isSafeInteger(total) || (total as number) < 0) return null;
    if (!Array.isArray(buckets) || buckets.length > MAX_LEADERBOARD_RECEIPTS) return null;
    let sum = 0;
    const read: LeaderboardBucket[] = [];
    for (const entry of buckets) {
      const count = ownData(entry, 'count');
      const players = ownData(entry, 'players');
      if (!Number.isSafeInteger(count) || (count as number) <= 0 || !Number.isSafeInteger(players) || (players as number) <= 0) {
        return null;
      }
      sum += players as number;
      read.push(Object.freeze({ count: count as number, players: players as number }));
    }
    if (sum !== total) return null;
    return Object.freeze({ season, total: total as number, buckets: Object.freeze(read) });
  } catch {
    return null;
  }
}

function canonicalContract(address: Address): Address {
  if (typeof address !== 'string' || !isFelt(address) || BigInt(address) === 0n || BigInt(address) >= CONTRACT_ADDRESS_BOUND) {
    throw new PrivacyError('unknown', 'Invalid ledger address.');
  }
  return toFelt(BigInt(address));
}

function toFelt(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function isFelt(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(value) && BigInt(value) < STARK_FIELD_PRIME;
}

function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
