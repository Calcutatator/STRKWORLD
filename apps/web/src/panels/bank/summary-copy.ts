import type { BatchWarning, Intent } from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import { formatStrkExact, shortenAddress } from '../../format.js';

/**
 * Turning seam data into sentences.
 *
 * Extracted from the component so it can be tested without a renderer — the
 * prompt-count rule in particular is a copy rule, and a copy rule that only
 * exists inside JSX is a copy rule nobody checks.
 *
 * Amounts here are exact. These are the figures a player agrees to, and a
 * truncated one is a different number to the one being signed.
 */

export function describeIntent(intent: Intent): string {
  switch (intent.kind) {
    case 'shield':
      return `${COPY.bank.shield} ${formatStrkExact(intent.amount)}`;
    case 'unshield':
      return `${COPY.bank.unshield} ${formatStrkExact(intent.amount)} → ${shortenAddress(intent.recipient)}`;
    case 'transfer':
      return `${COPY.bank.transfer} ${formatStrkExact(intent.amount)} → ${shortenAddress(intent.recipient)}`;
    case 'swap':
      return `${formatStrkExact(intent.amountIn)} → ${shortenAddress(intent.tokenOut)}`;
    case 'stake':
      // STRK in is the only input the stake route admits. xSTRK out is named,
      // never numbered: nothing the seam returns carries its amount (D-063).
      return `${COPY.bank.stake} ${formatStrkExact(intent.amountIn)} → ${COPY.stake.outputToken}`;
  }
}

/**
 * Seam warnings, said plainly.
 *
 * `public-leg` carries its own detail string from `packages/privacy`
 * describing exactly what becomes visible; it is shown as given rather than
 * summarised, for the same reason the approved disclosures are.
 *
 * `multiple-prompts` deliberately drops the count. The seam knows what the
 * shipped wallet source implies, but the funded UI run has not happened
 * (D-028), and SPEC §5 rule 5 says not to encode wallet behaviour into copy.
 * "More than once" is true under every count the run could return.
 *
 * `funds-maturing` renders `blocksRemaining` as an approximate wait. There is
 * no block-time constant anywhere in this repository to convert it into a
 * seconds estimate, and inventing one would be a guess dressed up as a fact —
 * so this says "about N blocks", not "about N seconds".
 */
export function describeWarning(warning: BatchWarning): string {
  switch (warning.kind) {
    case 'public-leg':
      return warning.detail;
    case 'leaves-below-fee':
      return `${COPY.balance.feeReserved} (${formatStrkExact(warning.remaining)} left)`;
    case 'funds-maturing':
      return `${COPY.balance.maturing} ${formatStrkExact(warning.maturingAmount)} (${maturityEta(warning.blocksRemaining)})`;
    case 'recipient-unregistered':
      return COPY.notices.recipientUnregistered;
    case 'multiple-prompts':
      return COPY.flow.mayAskMoreThanOnce;
  }
}

function maturityEta(blocksRemaining: number): string {
  return `about ${blocksRemaining} block${blocksRemaining === 1 ? '' : 's'}`;
}
