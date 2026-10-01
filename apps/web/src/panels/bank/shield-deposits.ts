import type { Address, Intent } from '@strkworld/privacy';
import { sameAddress } from '../../format.js';

/**
 * D-094: what each shield deposits, the shell's copy of the seam's
 * `shieldDeposits` rule (`packages/privacy/src/shield-deposit.ts`). The seam
 * re-exports the wallet adapter, which pulls `starknet`, so the eager shell
 * may only import its types (`architecture.test.ts`); `shield-deposits.test.ts`
 * holds the two to the same answers.
 *
 * The first shield in the pool's fee token carries the fee on top, so its
 * note is its amount; another token's shield deposits its amount. Zero for
 * anything that is not a shield.
 */
export function shieldDeposits(
  intents: readonly Intent[],
  pool: { readonly feeToken: Address; readonly feeAmount: bigint },
): readonly bigint[] {
  let feeAdded = false;
  return intents.map((intent) => {
    if (intent.kind !== 'shield') return 0n;
    if (!feeAdded && sameAddress(intent.token, pool.feeToken)) {
      feeAdded = true;
      return intent.amount + pool.feeAmount;
    }
    return intent.amount;
  });
}
