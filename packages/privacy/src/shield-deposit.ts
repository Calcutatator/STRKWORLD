import type { Intent } from './operations.js';
import type { Address } from './types.js';

/**
 * D-094: a shield's amount is what reaches the pool, and the pool fee goes on
 * top of it.
 *
 * Measured on mainnet on 2026-10-01 (tx `0x6d1a6aef…bcb`): a Ready shield of
 * 9 STRK from an account with nothing in the pool deposited 9 STRK, the pool
 * withdrew its 6 STRK fee to avnu's relayer (which also paid the network
 * fee) and opened a note of about 3 STRK. So a shield in the pool's fee token
 * deposits `amount + feeAmount`, and its note is `amount`.
 *
 * The fee is charged once per pool transaction, so only the first shield in
 * the fee token carries it. A shield in another token deposits its amount as
 * it stands: the fee is a STRK amount and cannot come out of it, and where
 * the wallet takes it from instead is not established, so nothing is added.
 *
 * Returns one figure per intent, in intent order: the deposit for a shield,
 * and zero for anything else.
 */
export function shieldDeposits(
  intents: readonly Intent[],
  pool: { readonly feeToken: Address; readonly feeAmount: bigint },
): readonly bigint[] {
  let feeAdded = false;
  return intents.map((intent) => {
    if (intent.kind !== 'shield') return 0n;
    if (!feeAdded && sameFelt(intent.token, pool.feeToken)) {
      feeAdded = true;
      return intent.amount + pool.feeAmount;
    }
    return intent.amount;
  });
}

function sameFelt(left: string, right: string): boolean {
  try {
    return BigInt(left) === BigInt(right);
  } catch {
    return false;
  }
}
