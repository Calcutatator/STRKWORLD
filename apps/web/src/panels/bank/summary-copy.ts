import type { Address, BatchWarning, Intent } from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import { formatStrkExact, formatTokenAmountExact, shortenAddress } from '../../format.js';
import { catalogAsset } from '../exchange/catalog.js';

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

/**
 * An exact amount in its own token: "0.5 STRK", "12.5 USDC", with the Exchange
 * catalog's decimals and symbol (D-042). Since D-072 a shield may be any
 * token, so no amount is assumed to be STRK. A token the catalog cannot
 * describe keeps its base units and is named by its address, never by a
 * symbol it might not have.
 */
export function formatTokenFigure(token: Address, amount: bigint): string {
  const asset = catalogAsset(token);
  return asset
    ? `${formatTokenAmountExact(amount, asset.decimals)} ${asset.symbol}`
    : `${amount} base units of ${shortenAddress(token)}`;
}

export function describeIntent(intent: Intent): string {
  switch (intent.kind) {
    case 'shield':
      return `${COPY.bank.shield} ${formatTokenFigure(intent.token, intent.amount)}`;
    case 'unshield':
      return `${COPY.bank.unshield} ${formatTokenFigure(intent.token, intent.amount)} → ${shortenAddress(intent.recipient)}`;
    case 'transfer':
      return `${COPY.bank.transfer} ${formatTokenFigure(intent.token, intent.amount)} → ${shortenAddress(intent.recipient)}`;
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

/**
 * Every warning for one prepared batch, in order.
 *
 * A shield's `public-leg` warning is written here from the shield it belongs
 * to, with the token's decimals and symbol: "Depositing 0.5 STRK is public:
 * the amount and your address are visible on-chain." The seam's own `detail`
 * prints the amount in base units. Both adapters emit one `public-leg` per
 * shield or unshield intent, in intent order (`warningsFor`, and the fake's
 * prepare), and a batch never mixes the two, so the n-th `public-leg` belongs
 * to the n-th such intent. When the counts disagree nothing is paired, and a
 * detail with no describable shield behind it is shown as the seam wrote it.
 */
export function describeWarnings(warnings: readonly BatchWarning[], intents: readonly Intent[]): string[] {
  const legs = intents.filter((intent) => intent.kind === 'shield' || intent.kind === 'unshield');
  const paired = warnings.filter((warning) => warning.kind === 'public-leg').length === legs.length;
  let leg = 0;
  return warnings.map((warning) => {
    if (warning.kind !== 'public-leg') return describeWarning(warning);
    const intent = paired ? legs[leg] : undefined;
    leg += 1;
    return intent?.kind === 'shield' && catalogAsset(intent.token)
      ? `${COPY.warnings.depositPublicLead} ${formatTokenFigure(intent.token, intent.amount)} ${COPY.warnings.depositPublicTail}`
      : describeWarning(warning);
  });
}

function maturityEta(blocksRemaining: number): string {
  return `about ${blocksRemaining} block${blocksRemaining === 1 ? '' : 's'}`;
}
