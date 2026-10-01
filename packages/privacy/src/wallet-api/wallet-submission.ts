import type { STRK20_ACTION } from 'starknet';
import { PrivacyError } from '../types.js';
import type { PoolReadClient, WalletStrk20Account } from './types.js';

/**
 * Wallet submission (D-077, D-082): the wallet proves **and submits** a
 * STRK20 transaction through `wallet_strk20InvokeTransaction`. No STRKWORLD
 * relay, no avnu key and no relay fee: the wallet adds and prices its own
 * network fee. The Vault and every pool spend but the quote-bound swap go
 * this way; shield always has.
 *
 * What is shared here is the part that must behave the same everywhere: the
 * reviewed actions are frozen once and the wallet only ever gets its own
 * copy, the answer must be a real transaction hash, and a receipt is read on
 * one bounded schedule.
 */

const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

/**
 * The pauses between receipt reads once the wallet has submitted, in ms:
 * about seventy seconds in all. The chain makes a block every couple of
 * seconds, and a proved STRK20 transaction usually lands within a few.
 */
export const WALLET_RECEIPT_WAITS_MS: readonly number[] = Object.freeze([
  2_000, 3_000, 4_000, 5_000, 6_000, 8_000, 10_000, 12_000, 20_000,
]);

/**
 * Ask the wallet to prove and submit the reviewed actions, and return the
 * transaction hash it answers. The wallet gets a fresh copy, so nothing it
 * does to its argument reaches the reviewed snapshot. A wallet failure is
 * thrown as the wallet threw it: each caller maps it for its own route.
 * An answer without a nonzero felt hash rejects `unknown`.
 */
export async function submitThroughWallet(
  wallet: WalletStrk20Account,
  reviewed: readonly STRK20_ACTION[],
): Promise<string> {
  const result = await wallet.strk20InvokeTransaction(copyActions(reviewed));
  return readSubmittedHash(result);
}

/** The wallet's `transaction_hash`: an own data property holding a nonzero felt. */
export function readSubmittedHash(value: unknown): string {
  let hash: unknown;
  try {
    const descriptor = value && typeof value === 'object'
      ? Object.getOwnPropertyDescriptor(value, 'transaction_hash')
      : undefined;
    hash = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    hash = undefined;
  }
  if (typeof hash !== 'string' || !isFelt(hash) || BigInt(hash) === 0n) {
    throw new PrivacyError('unknown', 'The wallet returned an invalid transaction result.');
  }
  return hash;
}

/**
 * Read a submitted transaction's receipt on `waits` until `classify` settles
 * it, the schedule ends, or the caller stops waiting. A read that fails is
 * retried at the next pause. Resolves the settled answer, or `pending` with
 * whether any receipt read answered at all; it never rejects.
 */
export async function waitForReceipt<Settled extends string>(input: {
  readonly pool: PoolReadClient;
  readonly transactionHash: string;
  readonly waits: readonly number[];
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly classify: (receipt: unknown) => Settled | 'pending';
}): Promise<{ readonly outcome: Settled | 'pending'; readonly readable: boolean }> {
  const { pool, transactionHash, waits, sleep, signal, classify } = input;
  let readable = false;
  for (const wait of waits) {
    if (signal?.aborted) break;
    try {
      await sleep(wait, signal);
    } catch {
      break;
    }
    if (signal?.aborted) break;
    let receipt: unknown;
    try {
      receipt = await pool.receipt(transactionHash, signal);
    } catch {
      continue;
    }
    readable = true;
    const outcome = classify(receipt);
    if (outcome !== 'pending') return { outcome, readable };
  }
  return { outcome: 'pending', readable };
}

/** A receipt schedule, checked and frozen: whole, non-negative milliseconds. */
export function ownReceiptWaits(waits: readonly number[], message: string): readonly number[] {
  if (!Array.isArray(waits) || waits.some((wait) => !Number.isSafeInteger(wait) || wait < 0)) {
    throw new PrivacyError('unknown', message);
  }
  return Object.freeze([...waits]);
}

/** Deep-frozen reviewed actions. Every leaf is a string, so this is complete. */
export function freezeActions(actions: readonly STRK20_ACTION[]): readonly STRK20_ACTION[] {
  return Object.freeze(actions.map((action) => {
    if (action.type === 'invoke') {
      return Object.freeze({ ...action, calldata: Object.freeze([...action.calldata]) });
    }
    if (action.type !== 'shadow_account_invoke') return Object.freeze({ ...action });
    return Object.freeze({
      ...action,
      calls: Object.freeze(action.calls.map((call) => Object.freeze({
        ...call,
        calldata: Object.freeze([...(call.calldata as string[])]),
      }))),
      collect_policy: Object.freeze({ ...action.collect_policy }),
    });
  })) as readonly STRK20_ACTION[];
}

/** A fresh, mutable copy of the reviewed actions for the wallet to take. */
export function copyActions(actions: readonly STRK20_ACTION[]): STRK20_ACTION[] {
  return actions.map((action) => {
    if (action.type === 'invoke') return { ...action, calldata: [...action.calldata] };
    if (action.type !== 'shadow_account_invoke') return { ...action };
    return {
      ...action,
      calls: action.calls.map((call) => ({ ...call, calldata: [...(call.calldata as string[])] })),
      collect_policy: { ...action.collect_policy },
    } as STRK20_ACTION;
  });
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PrivacyError('user-rejected', 'Operation cancelled.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new PrivacyError('user-rejected', 'Operation cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isFelt(value: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(value) && BigInt(value) < STARK_FIELD_PRIME;
}
