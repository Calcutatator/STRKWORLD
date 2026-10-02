import { useEffect, useState } from 'react';
import type { PrivacyOperations } from '@strkworld/privacy';

/**
 * The pool fee, read once from the pool's config while a counter is open: an
 * ordinary chain read that asks no wallet, as the Bank machine's `open()`
 * makes. For the amounts a counter shows before its review (D-103): null
 * until it lands, or if it fails, and the row is then left out rather than
 * guessed. The review always shows the prepared action's own exact fee.
 */
export function usePoolFee(operations: PrivacyOperations): bigint | null {
  const [fee, setFee] = useState<bigint | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    operations.poolConfig(controller.signal).then(
      (pool) => {
        if (!controller.signal.aborted) setFee(pool.feeAmount);
      },
      () => {
        // No figure rather than a guessed one.
      },
    );
    return () => controller.abort();
  }, [operations]);
  return fee;
}
