import type { DepositStatus } from './operations.js';

/**
 * The STRK20 privacy pool, and how a deposit into it reads in a receipt (D-072).
 *
 * Protocol constants, not configuration, like `endur.ts`. Mainnet only
 * (D-001). The receipt comes from a public chain read through the backend
 * (D-014), never from the wallet, so confirming a deposit raises no prompt,
 * and nothing here returns the deposited amount.
 */

/**
 * The canonical mainnet pool, the same value the backend's
 * `STRK20_POOL_ADDRESS` holds.
 */
export const STRK20_POOL = '0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a';

/**
 * `sn_keccak('Deposit')`, the first key of the pool's `Deposit` event.
 *
 * Read from the deployed class ABI on 2026-09-29: `Deposit` is a `nested`
 * variant of `privacy::privacy::Privacy::Event`, and
 * `privacy::events::Deposit` carries `user_addr` and `token` as keys and a
 * `u128` amount as data. So every deposit emits keys
 * `[this selector, user_addr, token]` and data `[amount]`.
 */
export const POOL_DEPOSIT_EVENT = '0x9149d2123147c5f43d258257fef0b7b969db78269369ebcf5ebb9eef8592f2';

/** Receipts the network has accepted into a block. `PRE_CONFIRMED` is not yet. */
const ACCEPTED = new Set(['ACCEPTED_ON_L2', 'ACCEPTED_ON_L1']);

/** More events than any pool transaction emits; a larger list is not trusted. */
const MAX_EVENTS = 4_096;

const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

/**
 * What a transaction receipt says about a deposit into the pool by `account`.
 *
 * `landed` needs all of it: this transaction's own receipt, execution
 * `SUCCEEDED`, finality accepted, and a pool `Deposit` event whose
 * `user_addr` key is `account`. A reverted, accepted transaction is `failed`,
 * and so is an accepted success without that event. Anything else, including
 * a receipt that is missing, malformed, hostile or for another transaction, is
 * `pending`: it can never read as a deposit that landed.
 */
export function depositStatusFromReceipt(
  receipt: unknown,
  expected: { readonly transactionHash: string; readonly account: string },
): DepositStatus {
  try {
    if (!isRecord(receipt)) return 'pending';
    if (!sameFelt(ownData(receipt, 'transaction_hash'), expected.transactionHash)) return 'pending';
    const finality = ownData(receipt, 'finality_status');
    if (typeof finality !== 'string' || !ACCEPTED.has(finality)) return 'pending';
    const execution = ownData(receipt, 'execution_status');
    if (execution === 'REVERTED') return 'failed';
    if (execution !== 'SUCCEEDED') return 'pending';
    const events = ownData(receipt, 'events');
    if (!Array.isArray(events)) return 'pending';
    const count = ownData(events, 'length');
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > MAX_EVENTS) {
      return 'pending';
    }
    for (let index = 0; index < count; index += 1) {
      if (isDepositFor(ownData(events, String(index)), expected.account)) return 'landed';
    }
    return 'failed';
  } catch {
    // A hostile receipt proves nothing either way.
    return 'pending';
  }
}

function isDepositFor(event: unknown, account: string): boolean {
  if (!isRecord(event) || !sameFelt(ownData(event, 'from_address'), STRK20_POOL)) return false;
  const keys = ownData(event, 'keys');
  if (!Array.isArray(keys)) return false;
  return sameFelt(ownData(keys, '0'), POOL_DEPOSIT_EVENT) && sameFelt(ownData(keys, '1'), account);
}

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An own data property, never a getter or an inherited value. */
function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** Field-element equality: the chain pads and cases addresses as it likes. */
function sameFelt(value: unknown, expected: string): boolean {
  if (typeof value !== 'string' || !isFelt(value) || typeof expected !== 'string' || !isFelt(expected)) return false;
  return BigInt(value) === BigInt(expected);
}

function isFelt(value: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(value) && BigInt(value) < STARK_FIELD_PRIME;
}
